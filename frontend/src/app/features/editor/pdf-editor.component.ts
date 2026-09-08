import { CommonModule } from '@angular/common';
import { Component, OnDestroy, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, finalize, interval, switchMap, takeWhile } from 'rxjs';

import { ApiService } from '../../core/services/api.service';
import { PdfDocHandle, PdfPreviewService } from '../../shared/pdf-preview/pdf-preview.service';
import { PdfMarkupCanvasComponent } from '../../shared/pdf-markup/pdf-markup-canvas.component';
import { MarkupPropsComponent } from '../../shared/pdf-markup/markup-props.component';
import {
  CHECK_COLOR, CanvasMode, ElementType, HIGHLIGHT_COLOR, MarkKind, MarkupElement, STAMP_PRESETS,
  STROKE_COLOR, clamp, createElement, elementsToEdits, imageAspect, isShape, typeLabel,
} from '../../shared/pdf-markup/markup-element';

/**
 * Editor de PDF clásico (ruta /editor): una sola operación de marcado sobre un
 * archivo subido, que termina en descarga.
 *
 * El visor y el panel de propiedades viven en `shared/pdf-markup/` y los comparte
 * con el Estudio; aquí solo queda lo propio de esta pantalla: la paleta de
 * herramientas, la carga del archivo y el envío.
 */
@Component({
  selector: 'app-pdf-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, PdfMarkupCanvasComponent, MarkupPropsComponent],
  templateUrl: './pdf-editor.component.html',
  styleUrl: './pdf-editor.component.scss',
})
export class PdfEditorComponent implements OnDestroy {
  file: File | null = null;
  doc: PdfDocHandle | null = null;
  pageCount = 0;
  currentPage = 1;
  /** alto/ancho de la página mostrada; lo reporta el lienzo al renderizar. */
  pageAspect = Math.SQRT2;

  elements: MarkupElement[] = [];
  selectedId = '';
  busy = false;
  statusMessage = '';
  errorMessage = '';

  mode: CanvasMode = 'select';
  readonly stampPresets = STAMP_PRESETS;

  isShape = isShape;
  typeLabel = typeLabel;

  private pollSub?: Subscription;

  @ViewChild(PdfMarkupCanvasComponent) private canvas?: PdfMarkupCanvasComponent;

  constructor(
    private readonly api: ApiService,
    private readonly pdf: PdfPreviewService,
  ) {}

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    void this.doc?.destroy();
    this.revokeImages();
  }

  get elementsOnPage(): MarkupElement[] {
    return this.elements.filter((e) => e.page === this.currentPage);
  }

  get selected(): MarkupElement | undefined {
    return this.elements.find((e) => e.id === this.selectedId);
  }

  get polyDraftLength(): number {
    return this.canvas?.polyDraft.length ?? 0;
  }

  // --- carga del PDF ---

  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await this.loadFile(file);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) await this.loadFile(file);
  }

  private async loadFile(file: File): Promise<void> {
    this.errorMessage = '';
    if (file.type !== 'application/pdf') {
      this.errorMessage = 'El archivo debe ser un PDF.';
      return;
    }
    this.busy = true;
    this.statusMessage = 'Abriendo PDF…';
    try {
      const doc = await this.pdf.open(file);
      void this.doc?.destroy();
      this.file = file;
      this.doc = doc;
      this.pageCount = doc.pageCount;
      this.currentPage = 1;
      this.elements = [];
      this.selectedId = '';
      this.statusMessage = '';
    } catch (e) {
      this.errorMessage = e === 'password'
        ? 'El PDF está protegido con contraseña; quítala antes de editar.'
        : 'No se pudo abrir el PDF.';
    } finally {
      this.busy = false;
    }
  }

  goToPage(page: number): void {
    if (!this.doc || page < 1 || page > this.pageCount) return;
    this.currentPage = page;
  }

  onPageAspect(aspect: number): void {
    this.pageAspect = aspect;
  }

  // --- crear / borrar elementos ---

  addText(): void {
    this.add({ type: 'text', text: 'Texto', width: 0.3, height: 0.05 });
  }

  addWhiteout(): void {
    this.add({ type: 'whiteout', text: '', width: 0.25, height: 0.03 });
  }

  addHighlight(): void {
    this.add({ type: 'highlight', width: 0.3, height: 0.04, color: HIGHLIGHT_COLOR });
  }

  addUnderline(): void {
    this.add({ type: 'underline', width: 0.3, height: 0.02, color: STROKE_COLOR });
  }

  addStrikeout(): void {
    this.add({ type: 'strikeout', width: 0.3, height: 0.03, color: STROKE_COLOR });
  }

  addLine(): void {
    this.add({ type: 'line', width: 0.25, height: 0.12, color: STROKE_COLOR });
  }

  addArrow(): void {
    this.add({ type: 'arrow', width: 0.25, height: 0.12, color: STROKE_COLOR });
  }

  addRect(): void {
    this.add({ type: 'rect', width: 0.3, height: 0.12, color: STROKE_COLOR });
  }

  addEllipse(): void {
    this.add({ type: 'ellipse', width: 0.22, height: 0.08, color: STROKE_COLOR });
  }

  addMark(kind: MarkKind): void {
    // Caja visualmente cuadrada: la fracción de alto se compensa con el aspecto.
    const width = 0.05;
    this.add({
      type: 'mark', mark: kind, width,
      height: clamp(width / this.pageAspect, 0.02, 0.5),
      color: kind === 'check' ? CHECK_COLOR : STROKE_COLOR,
      strokeWidth: 3,
    });
  }

  addCloud(): void {
    this.add({ type: 'cloud', width: 0.3, height: 0.15, color: STROKE_COLOR });
  }

  addCallout(): void {
    const width = 0.28;
    const height = 0.06;
    const left = clamp(0.5 - width / 2, 0, 1 - width);
    const top = 0.35;
    this.add({
      type: 'callout', text: 'Escribe aquí', width, height,
      color: STROKE_COLOR,
      tipX: clamp(left - 0.08, 0, 1),
      tipY: clamp(top + height + 0.12, 0, 1),
    });
  }

  addStamp(preset: string): void {
    this.add({
      type: 'stamp', text: preset, width: 0.26, height: 0.055,
      color: STROKE_COLOR, strokeWidth: 2.5, showDatetime: false,
    });
  }

  toggleMode(mode: CanvasMode): void {
    this.mode = this.mode === mode ? 'select' : mode;
    if (this.mode !== 'select') this.selectedId = '';
  }

  finishPolygon(): void {
    this.canvas?.finishPolygon();
  }

  onPolygonFinished(): void {
    this.mode = 'select';
  }

  async onImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      this.errorMessage = 'La imagen debe ser PNG o JPEG.';
      return;
    }
    const url = URL.createObjectURL(file);
    const aspect = await imageAspect(url).catch(() => 0.6);
    // La altura inicial respeta el aspect ratio sobre un ancho del 25%.
    const width = 0.25;
    this.add({
      type: 'image', width, height: clamp(width * aspect / this.pageAspect, 0.03, 0.9),
      imageFile: file, imageUrl: url, imageAspect: aspect,
    });
  }

  private add(partial: Partial<MarkupElement> & { type: ElementType }): void {
    const el = createElement(this.currentPage, partial);
    this.elements = [...this.elements, el];
    this.selectedId = el.id;
    this.errorMessage = '';
  }

  onElementsChange(elements: MarkupElement[]): void {
    this.elements = [...elements];
  }

  remove(el: MarkupElement): void {
    if (el.imageUrl) URL.revokeObjectURL(el.imageUrl);
    this.elements = this.elements.filter((e) => e.id !== el.id);
    if (this.selectedId === el.id) this.selectedId = '';
  }

  // --- envío ---

  async apply(): Promise<void> {
    if (!this.file || !this.elements.length || this.busy) return;
    this.busy = true;
    this.errorMessage = '';
    this.statusMessage = 'Aplicando cambios…';

    const { edits, images } = elementsToEdits(this.elements);

    this.api.editPdf(this.file, edits, images).subscribe({
      next: (res) => {
        if (res.success && res.data?.jobId) {
          this.poll(res.data.jobId);
        } else {
          this.busy = false;
          this.errorMessage = res.error?.message ?? 'No se pudo aplicar la edición.';
        }
      },
      error: (err) => {
        this.busy = false;
        this.errorMessage = err?.error?.error?.message ?? 'Error al comunicarse con el servidor.';
      },
    });
  }

  private poll(jobId: string): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(1500)
      .pipe(
        switchMap(() => this.api.getJobStatus(jobId)),
        takeWhile((r) => r.data?.status === 'pending' || r.data?.status === 'processing', true),
      )
      .subscribe({
        next: (r) => {
          const status = r.data?.status;
          if (status === 'completed') this.download(jobId);
          else if (status === 'failed') {
            this.busy = false;
            this.statusMessage = '';
            this.errorMessage = r.data?.errorMessage ?? 'La edición del PDF falló.';
          }
        },
        error: () => {
          this.busy = false;
          this.errorMessage = 'Error al consultar el estado.';
        },
      });
  }

  private download(jobId: string): void {
    this.api.downloadFile(jobId).pipe(finalize(() => (this.busy = false))).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${(this.file?.name || 'documento').replace(/\.pdf$/i, '')}_editado.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.statusMessage = 'PDF editado y descargado.';
      },
      error: () => (this.errorMessage = 'Error al descargar el PDF editado.'),
    });
  }

  private revokeImages(): void {
    for (const el of this.elements) {
      if (el.imageUrl) URL.revokeObjectURL(el.imageUrl);
    }
  }
}
