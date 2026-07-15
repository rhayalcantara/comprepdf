import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, finalize, interval, switchMap, takeWhile } from 'rxjs';

import { ApiService, FormDefinition, JobResponse } from '../../core/services/api.service';
import {
  createForm,
  createQuestion,
  FormQuestion,
  FormQuestionType,
  QUESTION_TYPES,
} from './form.models';

type PreviewDevice = 'desktop' | 'tablet' | 'mobile';

/**
 * Editor de formularios PDF. La vista previa y la descarga usan el flujo
 * asíncrono de ComprePDF: crean un job `form_generate` (render en el worker) y
 * luego se sondea hasta descargar el PDF como blob.
 */
@Component({
  selector: 'app-form-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './form-editor.component.html',
  styleUrl: './form-editor.component.scss',
})
export class FormEditorComponent implements OnInit, OnDestroy {
  readonly questionTypes = QUESTION_TYPES;
  definition: FormDefinition = createForm();
  selectedQuestionId = this.definition.questions[0]?.id ?? '';
  previewDevice: PreviewDevice = 'desktop';
  saved = false;
  busy = false;
  statusMessage = 'Borrador nuevo';
  errorMessage = '';
  pdfUrl?: SafeResourceUrl;

  private pdfObjectUrl?: string;
  private pdfBlob?: Blob;
  private pollSub?: Subscription;

  constructor(
    private readonly api: ApiService,
    private readonly sanitizer: DomSanitizer,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    const formId = this.route.snapshot.paramMap.get('id');
    if (!formId) return;

    this.busy = true;
    this.statusMessage = 'Cargando formulario';
    this.api
      .getForm(formId)
      .pipe(finalize(() => (this.busy = false)))
      .subscribe({
        next: (res) => {
          if (!res.success || !res.data) {
            this.errorMessage = res.error?.message ?? 'No se pudo cargar el formulario.';
            return;
          }
          this.definition = res.data;
          this.selectedQuestionId = res.data.questions[0]?.id ?? '';
          this.saved = true;
          this.statusMessage = `Guardado · versión ${res.data.version ?? 1}`;
        },
        error: (error) => this.showApiError(error),
      });
  }

  get selectedQuestion(): FormQuestion | undefined {
    return this.definition.questions.find((q) => q.id === this.selectedQuestionId);
  }

  selectQuestion(question: FormQuestion): void {
    this.selectedQuestionId = question.id;
  }

  addQuestion(type: FormQuestionType = 'short_text'): void {
    const question = createQuestion(type, this.definition.questions.length + 1);
    this.definition.questions.push(question);
    this.selectedQuestionId = question.id;
    this.markChanged();
  }

  removeQuestion(question: FormQuestion): void {
    const index = this.definition.questions.indexOf(question);
    this.definition.questions.splice(index, 1);
    this.selectedQuestionId = this.definition.questions[Math.max(0, index - 1)]?.id ?? '';
    this.markChanged();
  }

  moveQuestion(question: FormQuestion, direction: -1 | 1): void {
    const index = this.definition.questions.indexOf(question);
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= this.definition.questions.length) return;
    [this.definition.questions[index], this.definition.questions[nextIndex]] = [
      this.definition.questions[nextIndex],
      this.definition.questions[index],
    ];
    this.markChanged();
  }

  changeQuestionType(question: FormQuestion): void {
    if (question.type === 'radio' || question.type === 'select') {
      if (question.options.length < 2) question.options = ['Opción 1', 'Opción 2'];
    } else {
      question.options = [];
    }
    this.markChanged();
  }

  updateOptions(question: FormQuestion, rawValue: string): void {
    question.options = rawValue.split(',').map((o) => o.trim()).filter(Boolean);
    this.markChanged();
  }

  markChanged(): void {
    this.statusMessage = 'Cambios sin guardar';
    this.errorMessage = '';
    this.pdfBlob = undefined;
  }

  save(): void {
    if (!this.isValid()) return;
    this.busy = true;
    this.errorMessage = '';
    const request = this.saved ? this.api.updateForm(this.definition) : this.api.createForm(this.definition);
    request.pipe(finalize(() => (this.busy = false))).subscribe({
      next: (res) => {
        if (!res.success || !res.data) {
          this.errorMessage = res.error?.message ?? 'No fue posible guardar el formulario.';
          this.statusMessage = 'No guardado';
          return;
        }
        this.definition = res.data;
        this.saved = true;
        this.statusMessage = `Guardado · versión ${res.data.version ?? 1}`;
        if (!this.route.snapshot.paramMap.get('id')) {
          void this.router.navigate(['/formularios', res.data.id, 'editar'], { replaceUrl: true });
        }
      },
      error: (error) => this.showApiError(error),
    });
  }

  /** Genera la vista previa (job form_generate efímero) y la muestra en el iframe. */
  generatePreview(download = false): void {
    if (!this.isValid()) return;
    this.busy = true;
    this.errorMessage = '';
    this.statusMessage = 'Generando PDF…';
    this.api.previewForm(this.definition).subscribe({
      next: (res) => {
        if (res.success && res.data?.jobId) {
          this.pollJob(res.data.jobId, download);
        } else {
          this.busy = false;
          this.errorMessage = res.error?.message ?? 'No fue posible generar el PDF.';
        }
      },
      error: (error) => {
        this.busy = false;
        this.showApiError(error);
      },
    });
  }

  downloadPdf(): void {
    if (this.pdfBlob) {
      this.triggerDownload(this.pdfBlob);
      return;
    }
    this.generatePreview(true);
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    if (this.pdfObjectUrl) URL.revokeObjectURL(this.pdfObjectUrl);
  }

  /** Sondea el job hasta que completa/falla; al completar descarga el blob. */
  private pollJob(jobId: string, download: boolean): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(1500)
      .pipe(
        switchMap(() => this.api.getJobStatus(jobId)),
        takeWhile((r) => {
          const s = r.data?.status;
          return s === 'pending' || s === 'processing';
        }, true),
      )
      .subscribe({
        next: (r) => {
          const status = r.data?.status;
          if (status === 'completed') {
            this.fetchResult(jobId, download);
          } else if (status === 'failed') {
            this.busy = false;
            this.statusMessage = 'No generado';
            this.errorMessage = r.data?.errorMessage ?? 'La generación del PDF falló.';
          }
        },
        error: () => {
          this.busy = false;
          this.errorMessage = 'Error al consultar el estado del PDF.';
        },
      });
  }

  private fetchResult(jobId: string, download: boolean): void {
    this.api.downloadFile(jobId).subscribe({
      next: (blob) => {
        this.busy = false;
        this.pdfBlob = blob;
        if (this.pdfObjectUrl) URL.revokeObjectURL(this.pdfObjectUrl);
        this.pdfObjectUrl = URL.createObjectURL(blob);
        this.pdfUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.pdfObjectUrl);
        this.statusMessage = 'Vista previa actualizada';
        if (download) this.triggerDownload(blob);
      },
      error: () => {
        this.busy = false;
        this.errorMessage = 'Error al descargar el PDF generado.';
      },
    });
  }

  private triggerDownload(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.safeName()}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private safeName(): string {
    return (
      this.definition.name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'formulario'
    );
  }

  private isValid(): boolean {
    const names = this.definition.questions.map((q) => q.name);
    const invalidSelection = this.definition.questions.some(
      (q) => (q.type === 'radio' || q.type === 'select') && q.options.length < 2,
    );
    if (!this.definition.name.trim() || !this.definition.header.title.trim()) {
      this.errorMessage = 'El nombre y el título del formulario son obligatorios.';
    } else if (names.some((name) => !/^[a-zA-Z][a-zA-Z0-9_]{1,63}$/.test(name))) {
      this.errorMessage = 'Cada nombre de campo debe comenzar con una letra y usar solo letras, números o guion bajo (mínimo 2 caracteres).';
    } else if (new Set(names).size !== names.length) {
      this.errorMessage = 'Los nombres internos de las preguntas no pueden repetirse.';
    } else if (invalidSelection) {
      this.errorMessage = 'Las preguntas de selección necesitan al menos dos opciones.';
    } else {
      return true;
    }
    return false;
  }

  private showApiError(error: { error?: { error?: { message?: string }; message?: string } }): void {
    const message = error.error?.error?.message ?? error.error?.message;
    this.errorMessage = typeof message === 'string' ? message : 'No fue posible comunicarse con el servidor.';
    this.statusMessage = 'No guardado';
  }
}
