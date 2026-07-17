import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, finalize, interval, switchMap, takeWhile } from 'rxjs';

import { ApiService, PdfEdit } from '../../core/services/api.service';
import { PdfDocHandle, PdfPreviewService } from '../../shared/pdf-preview/pdf-preview.service';

type ElementType = 'text' | 'image' | 'whiteout';

/** Un elemento colocado sobre el PDF. Fracciones con origen ARRIBA-izquierda
 *  (como en pantalla); se convierten a la convención PDF al enviar. */
interface EditorElement {
  id: string;
  type: ElementType;
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
  textColor: string;
  imageUrl?: string;
  imageFile?: File;
  imageAspect?: number;
}

const uid = (): string =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `el-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

@Component({
  selector: 'app-pdf-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './pdf-editor.component.html',
  styleUrl: './pdf-editor.component.scss',
})
export class PdfEditorComponent implements OnDestroy {
  file: File | null = null;
  doc: PdfDocHandle | null = null;
  pageCount = 0;
  currentPage = 1;
  pageAspect = Math.SQRT2; // alto/ancho de la página mostrada

  elements: EditorElement[] = [];
  selectedId = '';
  busy = false;
  statusMessage = '';
  errorMessage = '';

  private renderSeq = 0;
  private pollSub?: Subscription;
  private drag: {
    kind: 'move' | 'resize';
    el: EditorElement;
    startX: number;
    startY: number;
    left: number;
    top: number;
    width: number;
    height: number;
    frameW: number;
    frameH: number;
  } | null = null;

  @ViewChild('pageCanvas') private canvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('frame') private frameRef?: ElementRef<HTMLDivElement>;

  constructor(
    private readonly api: ApiService,
    private readonly pdf: PdfPreviewService,
  ) {}

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    void this.doc?.destroy();
    this.revokeImages();
  }

  get elementsOnPage(): EditorElement[] {
    return this.elements.filter((e) => e.page === this.currentPage);
  }

  get selected(): EditorElement | undefined {
    return this.elements.find((e) => e.id === this.selectedId);
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
      // El <canvas> vive tras un @if: no existe hasta que Angular actualiza la
      // vista con doc ya asignado. Esperar a que aparezca antes de renderizar.
      await this.renderWhenCanvasReady();
    } catch (e) {
      this.errorMessage = e === 'password'
        ? 'El PDF está protegido con contraseña; quítala antes de editar.'
        : 'No se pudo abrir el PDF.';
    } finally {
      this.busy = false;
    }
  }

  async goToPage(page: number): Promise<void> {
    if (!this.doc || page < 1 || page > this.pageCount) return;
    this.currentPage = page;
    await this.renderPage();
  }

  /** Espera (unos frames) a que el @if monte el canvas y entonces renderiza. */
  private async renderWhenCanvasReady(attempts = 20): Promise<void> {
    for (let i = 0; i < attempts && !this.canvasRef; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.renderPage();
  }

  private async renderPage(): Promise<void> {
    const canvas = this.canvasRef?.nativeElement;
    if (!this.doc || !canvas) return;
    const seq = ++this.renderSeq;
    const width = Math.min(this.frameRef?.nativeElement.clientWidth || 680, 900);
    try {
      await this.doc.render(this.currentPage, canvas, width);
      if (seq !== this.renderSeq) return;
      if (canvas.width > 0) this.pageAspect = canvas.height / canvas.width;
    } catch {
      /* render cancelado o fallido: se reintenta al navegar */
    }
  }

  // --- crear / borrar elementos ---

  addText(): void {
    this.add({ type: 'text', text: 'Texto', width: 0.3, height: 0.05 });
  }

  addWhiteout(): void {
    this.add({ type: 'whiteout', text: '', width: 0.25, height: 0.03 });
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

  private add(partial: Partial<EditorElement> & { type: ElementType }): void {
    const width = partial.width ?? 0.3;
    const height = partial.height ?? 0.05;
    const el: EditorElement = {
      id: uid(),
      page: this.currentPage,
      left: clamp(0.5 - width / 2, 0, 1 - width),
      top: clamp(0.45, 0, 1 - height),
      width,
      height,
      text: partial.text ?? '',
      fontSize: 12,
      color: partial.type === 'text' ? '#101828' : '#FFFFFF',
      textColor: '#101828',
      ...partial,
    };
    this.elements.push(el);
    this.selectedId = el.id;
    this.errorMessage = '';
  }

  select(el: EditorElement): void {
    this.selectedId = el.id;
  }

  remove(el: EditorElement): void {
    if (el.imageUrl) URL.revokeObjectURL(el.imageUrl);
    this.elements = this.elements.filter((e) => e.id !== el.id);
    if (this.selectedId === el.id) this.selectedId = '';
  }

  // --- arrastre / redimensión (adaptado de sign-placement) ---

  startDrag(ev: PointerEvent, el: EditorElement, kind: 'move' | 'resize'): void {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = this.frameRef?.nativeElement.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    this.selectedId = el.id;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.drag = {
      kind, el,
      startX: ev.clientX, startY: ev.clientY,
      left: el.left, top: el.top, width: el.width, height: el.height,
      frameW: rect.width, frameH: rect.height,
    };
  }

  onDragMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = (ev.clientX - d.startX) / d.frameW;
    const dy = (ev.clientY - d.startY) / d.frameH;
    if (d.kind === 'move') {
      d.el.left = clamp(d.left + dx, 0, 1 - d.el.width);
      d.el.top = clamp(d.top + dy, 0, 1 - d.el.height);
    } else {
      d.el.width = clamp(d.width + dx, 0.03, 1 - d.el.left);
      if (d.el.type === 'image' && d.el.imageAspect) {
        d.el.height = clamp(d.el.width * d.el.imageAspect / this.pageAspect, 0.02, 1 - d.el.top);
      } else {
        d.el.height = clamp(d.height + dy, 0.02, 1 - d.el.top);
      }
    }
  }

  endDrag(): void {
    this.drag = null;
  }

  // --- envío ---

  async apply(): Promise<void> {
    if (!this.file || !this.elements.length || this.busy) return;
    this.busy = true;
    this.errorMessage = '';
    this.statusMessage = 'Aplicando cambios…';

    const images: File[] = [];
    const edits: PdfEdit[] = this.elements.map((el) => {
      const base = {
        page: el.page,
        x: round(el.left),
        y: round(1 - el.top - el.height), // flip: pantalla (arriba) -> PDF (abajo)
        w: round(el.width),
        h: round(el.height),
      };
      if (el.type === 'image') {
        const image_index = images.push(el.imageFile!) - 1;
        return { ...base, type: 'image', image_index };
      }
      if (el.type === 'whiteout') {
        return { ...base, type: 'whiteout', text: el.text, font_size: el.fontSize,
                 color: el.color, color_text: el.textColor };
      }
      return { ...base, type: 'text', text: el.text, font_size: el.fontSize, color: el.color };
    });

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

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function imageAspect(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalHeight / img.naturalWidth);
    img.onerror = reject;
    img.src = url;
  });
}
