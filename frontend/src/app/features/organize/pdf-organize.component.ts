import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, OnDestroy, QueryList, ViewChildren } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, finalize, interval, switchMap, takeWhile } from 'rxjs';

import { ApiService, OrganizedPage } from '../../core/services/api.service';
import { PdfDocHandle, PdfPreviewService } from '../../shared/pdf-preview/pdf-preview.service';

/**
 * Una tarjeta de la rejilla. `key` es estable e independiente de la posición
 * (el @for hace track por él), así que al reordenar Angular MUEVE el nodo y la
 * miniatura ya pintada viaja con su tarjeta: no hay que volver a renderizar.
 */
interface PageCard {
  key: string;
  /** Página del PDF original, 1-based. */
  source: number;
  /** Giro acumulado que el usuario le ha dado: 0, 90, 180 o 270. */
  rotate: number;
}

/** Ancho en px al que se rasteriza cada miniatura. */
const THUMB_WIDTH = 150;

@Component({
  selector: 'app-pdf-organize',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './pdf-organize.component.html',
  styleUrl: './pdf-organize.component.scss',
})
export class PdfOrganizeComponent implements AfterViewInit, OnDestroy {
  file: File | null = null;
  doc: PdfDocHandle | null = null;
  pageCount = 0;

  pages: PageCard[] = [];
  outputName = '';
  busy = false;
  statusMessage = '';
  errorMessage = '';

  /** Índice de la tarjeta que se está arrastrando (-1 = ninguna). */
  dragIndex = -1;
  dragOverIndex = -1;

  private pollSub?: Subscription;
  private readonly rendered = new Set<string>();

  @ViewChildren('thumb') private thumbs?: QueryList<ElementRef<HTMLCanvasElement>>;

  constructor(
    private readonly api: ApiService,
    private readonly pdf: PdfPreviewService,
  ) {}

  ngAfterViewInit(): void {
    // Las miniaturas se montan tras cargar el PDF (y tras cada cambio de la
    // rejilla): pintar las que aún no lo estén.
    this.thumbs?.changes.subscribe(() => void this.renderPending());
    void this.renderPending();
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    void this.doc?.destroy();
  }

  /** Páginas del original que el usuario ha quitado de la rejilla. */
  get removedCount(): number {
    return Math.max(0, this.pageCount - new Set(this.pages.map((p) => p.source)).size);
  }

  get dirty(): boolean {
    return this.pages.length !== this.pageCount
      || this.pages.some((p, i) => p.source !== i + 1 || p.rotate !== 0);
  }

  // --- carga del PDF ---

  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await this.loadFile(file);
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
      this.rendered.clear();
      this.reset();
      this.statusMessage = '';
    } catch (e) {
      this.errorMessage = e === 'password'
        ? 'El PDF está protegido con contraseña; quítala antes de organizarlo.'
        : 'No se pudo abrir el PDF.';
    } finally {
      this.busy = false;
    }
  }

  /** Vuelve al orden original, con todas las páginas y sin giros. */
  reset(): void {
    this.pages = Array.from({ length: this.pageCount }, (_, i) => ({
      key: `p${i + 1}`,
      source: i + 1,
      rotate: 0,
    }));
  }

  private async renderPending(): Promise<void> {
    const canvases = this.thumbs?.toArray() ?? [];
    if (!this.doc || !canvases.length) return;
    for (let i = 0; i < canvases.length && i < this.pages.length; i++) {
      const card = this.pages[i];
      if (this.rendered.has(card.key)) continue;
      this.rendered.add(card.key);
      try {
        await this.doc.render(card.source, canvases[i].nativeElement, THUMB_WIDTH);
      } catch {
        this.rendered.delete(card.key); // se reintenta en el siguiente cambio
      }
    }
  }

  // --- edición de la rejilla ---

  rotate(index: number): void {
    const card = this.pages[index];
    if (card) card.rotate = (card.rotate + 90) % 360;
  }

  remove(index: number): void {
    if (this.pages.length <= 1) {
      this.errorMessage = 'El documento debe conservar al menos una página.';
      return;
    }
    this.errorMessage = '';
    this.pages.splice(index, 1);
  }

  move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.pages.length) return;
    const [card] = this.pages.splice(index, 1);
    this.pages.splice(target, 0, card);
  }

  // --- arrastrar para reordenar (HTML5 drag & drop) ---

  onDragStart(index: number): void {
    this.dragIndex = index;
  }

  onDragOver(event: DragEvent, index: number): void {
    if (this.dragIndex < 0) return;
    event.preventDefault(); // sin esto el drop no se dispara
    this.dragOverIndex = index;
  }

  onDropCard(event: DragEvent, index: number): void {
    event.preventDefault();
    if (this.dragIndex >= 0 && this.dragIndex !== index) {
      this.move(this.dragIndex, index - this.dragIndex);
    }
    this.onDragEnd();
  }

  onDragEnd(): void {
    this.dragIndex = -1;
    this.dragOverIndex = -1;
  }

  // --- envío ---

  apply(): void {
    if (!this.file || !this.pages.length || this.busy) return;
    this.busy = true;
    this.errorMessage = '';
    this.statusMessage = 'Organizando páginas…';

    const pages: OrganizedPage[] = this.pages.map((p) => ({ source: p.source, rotate: p.rotate }));
    this.api.organizePdf(this.file, pages, this.outputName).subscribe({
      next: (res) => {
        if (res.success && res.data?.jobId) {
          this.poll(res.data.jobId);
        } else {
          this.busy = false;
          this.statusMessage = '';
          this.errorMessage = res.error?.message ?? 'No se pudo organizar el PDF.';
        }
      },
      error: (err) => {
        this.busy = false;
        this.statusMessage = '';
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
            this.errorMessage = r.data?.errorMessage ?? 'La organización del PDF falló.';
          }
        },
        error: () => {
          this.busy = false;
          this.statusMessage = '';
          this.errorMessage = 'Error al consultar el estado.';
        },
      });
  }

  private download(jobId: string): void {
    this.api.downloadFile(jobId).pipe(finalize(() => (this.busy = false))).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const base = this.outputName.trim()
          || `${(this.file?.name || 'documento').replace(/\.pdf$/i, '')}_organizado`;
        link.href = url;
        link.download = `${base.replace(/\.pdf$/i, '')}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.statusMessage = 'PDF organizado y descargado.';
      },
      error: () => {
        this.statusMessage = '';
        this.errorMessage = 'Error al descargar el PDF organizado.';
      },
    });
  }
}
