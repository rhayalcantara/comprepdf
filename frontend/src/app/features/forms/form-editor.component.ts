import { CdkDragDrop, DragDropModule, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
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
  createSection,
  FormColumns,
  FormQuestion,
  FormQuestionType,
  FormSection,
  MAX_COLUMNS,
  normalizeDefinition,
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
  imports: [CommonModule, DragDropModule, FormsModule, RouterLink],
  templateUrl: './form-editor.component.html',
  styleUrl: './form-editor.component.scss',
})
export class FormEditorComponent implements OnInit, OnDestroy {
  readonly questionTypes = QUESTION_TYPES;
  readonly columnOptions: FormColumns[] = [1, 2, 3];
  definition: FormDefinition = createForm();
  selectedQuestionId = this.definition.sections[0]?.questions[0]?.id ?? '';
  activeSectionId = this.definition.sections[0]?.id ?? '';
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
          this.loadDefinition(res.data);
          this.saved = true;
          this.statusMessage = `Guardado · versión ${res.data.version ?? 1}`;
        },
        error: (error) => this.showApiError(error),
      });
  }

  /** Todas las preguntas en orden de sección (el espejo plano no se edita). */
  get allQuestions(): FormQuestion[] {
    return this.definition.sections.flatMap((s) => s.questions);
  }

  get selectedQuestion(): FormQuestion | undefined {
    return this.allQuestions.find((q) => q.id === this.selectedQuestionId);
  }

  /** Sección que contiene la pregunta seleccionada; sus columnas acotan el span. */
  get selectedSection(): FormSection | undefined {
    return this.definition.sections.find((s) =>
      s.questions.some((q) => q.id === this.selectedQuestionId),
    );
  }

  /** Opciones de span disponibles para la pregunta seleccionada. */
  get spanOptions(): number[] {
    const columns = this.selectedSection?.columns ?? 1;
    return Array.from({ length: columns }, (_, i) => i + 1);
  }

  /** Sección donde caerán las preguntas nuevas. */
  get activeSectionTitle(): string {
    const section = this.definition.sections.find((s) => s.id === this.activeSectionId)
      ?? this.definition.sections[0];
    return section?.title?.trim() || 'Sección sin título';
  }

  selectQuestion(question: FormQuestion): void {
    this.selectedQuestionId = question.id;
    this.activeSectionId = this.selectedSection?.id ?? this.activeSectionId;
  }

  addQuestion(type: FormQuestionType = 'short_text'): void {
    const section = this.definition.sections.find((s) => s.id === this.activeSectionId)
      ?? this.definition.sections[0];
    if (!section) return;
    const question = createQuestion(type, this.allQuestions.length + 1);
    section.questions.push(question);
    this.selectedQuestionId = question.id;
    this.activeSectionId = section.id;
    this.markChanged();
  }

  removeQuestion(question: FormQuestion): void {
    const section = this.definition.sections.find((s) => s.questions.includes(question));
    if (!section) return;
    const index = section.questions.indexOf(question);
    section.questions.splice(index, 1);
    this.selectedQuestionId = section.questions[Math.max(0, index - 1)]?.id ?? '';
    this.markChanged();
  }

  moveQuestion(question: FormQuestion, direction: -1 | 1): void {
    const section = this.definition.sections.find((s) => s.questions.includes(question));
    if (!section) return;
    const index = section.questions.indexOf(question);
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= section.questions.length) return;
    [section.questions[index], section.questions[nextIndex]] = [
      section.questions[nextIndex],
      section.questions[index],
    ];
    this.markChanged();
  }

  // --- Secciones ---

  addSection(): void {
    const section = createSection(`Sección ${this.definition.sections.length + 1}`);
    this.definition.sections.push(section);
    this.activeSectionId = section.id;
    this.markChanged();
  }

  removeSection(section: FormSection): void {
    if (this.definition.sections.length <= 1) return;
    const index = this.definition.sections.indexOf(section);
    this.definition.sections.splice(index, 1);
    this.activeSectionId = this.definition.sections[Math.max(0, index - 1)]?.id ?? '';
    if (!this.allQuestions.some((q) => q.id === this.selectedQuestionId)) {
      this.selectedQuestionId = '';
    }
    this.markChanged();
  }

  /**
   * Al reducir las columnas hay que recortar los spans: si no, el backend
   * responde 400 ("ocupa 3 columnas pero la sección solo tiene 2") sobre una
   * pregunta que el usuario ni siquiera ha tocado.
   */
  setColumns(section: FormSection, columns: FormColumns): void {
    section.columns = Math.min(Math.max(columns, 1), MAX_COLUMNS) as FormColumns;
    section.questions.forEach((q) => {
      q.column_span = Math.min(q.column_span, section.columns);
    });
    this.markChanged();
  }

  drop(event: CdkDragDrop<FormQuestion[]>): void {
    const index = this.dropIndex(event);
    if (event.previousContainer === event.container) {
      moveItemInArray(event.container.data, event.previousIndex, index);
    } else {
      transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, index);
      // La sección de destino puede tener menos columnas que la de origen.
      const moved = event.container.data[index];
      const target = this.definition.sections.find((s) => s.questions.includes(moved));
      if (target) moved.column_span = Math.min(moved.column_span, target.columns);
    }
    this.markChanged();
  }

  /**
   * Índice donde insertar, calculado desde el punto en que se soltó.
   *
   * El CDK 17 solo ordena en un eje (`vertical` u `horizontal`); en una rejilla,
   * dos tarjetas de la misma fila comparten la Y y su `currentIndex` no las
   * distingue, así que arrastrar una al lado de otra no hacía nada. Con el
   * ordenado del CDK desactivado, el DOM no se mueve durante el arrastre y
   * podemos ubicar el punto en orden de lectura (fila, luego columna).
   */
  private dropIndex(event: CdkDragDrop<FormQuestion[]>): number {
    const dragged = event.item.element.nativeElement;
    const cards = Array.from(
      event.container.element.nativeElement.querySelectorAll<HTMLElement>('.question-card'),
    ).filter((card) => card !== dragged);
    if (!cards.length) return 0;

    const rects = cards.map((card) => card.getBoundingClientRect());
    const { x, y } = event.dropPoint;

    // Las tarjetas de una misma fila no miden lo mismo de alto (una casilla ocupa
    // menos que una selección múltiple), así que agrupamos por el borde superior
    // y usamos la banda completa de la fila en vez del rectángulo de cada una.
    const rows: number[][] = [];
    rects.forEach((rect, index) => {
      const row = rows.find((r) => Math.abs(rects[r[0]].top - rect.top) < 4);
      if (row) row.push(index);
      else rows.push([index]);
    });

    for (const row of rows) {
      if (y > Math.max(...row.map((i) => rects[i].bottom))) continue;   // el punto cae más abajo
      const hit = row.find((i) => x < rects[i].left + rects[i].width / 2);
      return hit ?? row[row.length - 1] + 1;
    }
    return cards.length;
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
        this.loadDefinition(res.data);
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

  /** Normaliza lo que llega del backend antes de editarlo. */
  private loadDefinition(raw: FormDefinition): void {
    this.definition = normalizeDefinition(raw);
    this.selectedQuestionId = this.allQuestions[0]?.id ?? '';
    this.activeSectionId = this.definition.sections[0]?.id ?? '';
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
    // Unicidad global, no por sección: el AcroForm es plano y dos campos con el
    // mismo nombre se fusionarían en uno.
    const names = this.allQuestions.map((q) => q.name);
    const invalidSelection = this.allQuestions.some(
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
