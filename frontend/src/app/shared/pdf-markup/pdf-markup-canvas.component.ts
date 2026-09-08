import { CommonModule } from '@angular/common';
import {
  Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { PdfDocHandle } from '../pdf-preview/pdf-preview.service';
import {
  CanvasMode, DRAW_MIN_STEP, MarkupElement, STROKE_COLOR, clamp, createElement, round,
  stampPreviewDate,
} from './markup-element';

/**
 * Lienzo de marcado: renderiza una página del PDF y superpone los elementos,
 * con arrastre, redimensión, dibujo libre y polígonos.
 *
 * Es el único visor con capa de edición del producto: lo usan `/editor` y el
 * Estudio. Los elementos se MUTAN en sitio (arrastrar cambia left/top del mismo
 * objeto); `elementsChange` solo se emite cuando la lista cambia de tamaño
 * (dibujo terminado), que es cuando el contenedor necesita enterarse.
 */
@Component({
  selector: 'app-pdf-markup-canvas',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './pdf-markup-canvas.component.html',
  styleUrl: './pdf-markup-canvas.component.scss',
})
export class PdfMarkupCanvasComponent implements OnChanges {
  @Input() doc: PdfDocHandle | null = null;
  @Input() page = 1;
  @Input() elements: MarkupElement[] = [];
  @Input() selectedId = '';
  @Input() mode: CanvasMode = 'select';
  /** Ancho máximo (px) del área de página. */
  @Input() maxWidth = 900;

  @Output() selectedIdChange = new EventEmitter<string>();
  /** La lista cambió de contenido (se añadió un trazo o un polígono). */
  @Output() elementsChange = new EventEmitter<MarkupElement[]>();
  /** Alto/ancho de la página mostrada; el contenedor lo necesita para las cajas. */
  @Output() pageAspectChange = new EventEmitter<number>();
  /** Un polígono se cerró: el contenedor devuelve el modo a 'select'. */
  @Output() polygonFinished = new EventEmitter<void>();

  /** Nivel de zoom del documento (1 = ajustado al ancho de la columna). */
  zoom = 1;
  /** Ancho en px del marco de la página (ancho base de la columna × zoom). */
  frameWidth: number | null = null;
  pageAspect = Math.SQRT2;

  /** Trazo en curso (dibujo libre), en fracciones del marco, origen arriba. */
  drawDraft: number[][] = [];
  /** Vértices del polígono en curso, en fracciones del marco, origen arriba. */
  polyDraft: number[][] = [];

  private renderSeq = 0;
  private drag: {
    kind: 'move' | 'resize' | 'tip';
    el: MarkupElement;
    startX: number;
    startY: number;
    left: number;
    top: number;
    width: number;
    height: number;
    frameW: number;
    frameH: number;
    tipX: number;
    tipY: number;
  } | null = null;

  @ViewChild('pageCanvas') private canvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('frame') private frameRef?: ElementRef<HTMLDivElement>;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['doc'] || changes['page']) {
      // El <canvas> puede no existir todavía (vive tras un @if del contenedor).
      void this.renderWhenCanvasReady();
    }
    if (changes['mode']) {
      this.drawDraft = [];
      this.polyDraft = [];
    }
  }

  get elementsOnPage(): MarkupElement[] {
    return this.elements.filter((e) => e.page === this.page);
  }

  // --- render ---

  /** Espera (unos frames) a que el @if monte el canvas y entonces renderiza. */
  async renderWhenCanvasReady(attempts = 20): Promise<void> {
    for (let i = 0; i < attempts && !this.canvasRef; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.renderPage();
  }

  async renderPage(): Promise<void> {
    const canvas = this.canvasRef?.nativeElement;
    if (!this.doc || !canvas || this.page < 1 || this.page > this.doc.pageCount) return;
    const seq = ++this.renderSeq;
    // Ancho base = la columna (no el marco: el marco crece con el zoom).
    const column = this.frameRef?.nativeElement.parentElement;
    const base = Math.min(column?.clientWidth || 680, this.maxWidth);
    const width = Math.round(base * this.zoom);
    try {
      await this.doc.render(this.page, canvas, width);
      if (seq !== this.renderSeq) return;
      this.frameWidth = width;
      if (canvas.width > 0) {
        this.pageAspect = canvas.height / canvas.width;
        this.pageAspectChange.emit(this.pageAspect);
      }
    } catch {
      /* render cancelado o fallido: se reintenta al navegar */
    }
  }

  setZoom(zoom: number): void {
    const next = clamp(Math.round(zoom * 100) / 100, 0.5, 3);
    if (next === this.zoom) return;
    this.zoom = next;
    void this.renderPage();
  }

  /** Zoom con Ctrl+rueda, manteniendo el punto bajo el cursor. */
  async onWheel(ev: WheelEvent): Promise<void> {
    if (!ev.ctrlKey || !this.doc) return;
    ev.preventDefault();
    const scroll = ev.currentTarget as HTMLElement;
    const frame = this.frameRef?.nativeElement;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const fx = (ev.clientX - rect.left) / Math.max(rect.width, 1);
    const fy = (ev.clientY - rect.top) / Math.max(rect.height, 1);
    const prev = this.zoom;
    this.setZoom(this.zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15));
    if (this.zoom === prev) return;
    // Tras el re-render, recolocar el scroll para que el punto siga bajo el cursor.
    await new Promise((r) => setTimeout(r, 60));
    const nrect = frame.getBoundingClientRect();
    scroll.scrollLeft += fx * nrect.width - (ev.clientX - nrect.left);
    scroll.scrollTop += fy * nrect.height - (ev.clientY - nrect.top);
  }

  // --- selección y arrastre ---

  select(el: MarkupElement): void {
    this.selectedId = el.id;
    this.selectedIdChange.emit(el.id);
  }

  startDrag(ev: PointerEvent, el: MarkupElement, kind: 'move' | 'resize' | 'tip'): void {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = this.frameRef?.nativeElement.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    this.select(el);
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.drag = {
      kind, el,
      startX: ev.clientX, startY: ev.clientY,
      left: el.left, top: el.top, width: el.width, height: el.height,
      frameW: rect.width, frameH: rect.height,
      tipX: el.tipX ?? 0, tipY: el.tipY ?? 0,
    };
  }

  onDragMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = (ev.clientX - d.startX) / d.frameW;
    const dy = (ev.clientY - d.startY) / d.frameH;
    if (d.kind === 'tip') {
      d.el.tipX = clamp(d.tipX + dx, 0, 1);
      d.el.tipY = clamp(d.tipY + dy, 0, 1);
    } else if (d.kind === 'move') {
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

  // --- dibujo libre y polígono ---

  /** Posición del puntero en fracciones del marco (origen arriba-izquierda). */
  private framePoint(ev: PointerEvent | MouseEvent): number[] | null {
    const rect = this.frameRef?.nativeElement.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return [
      clamp((ev.clientX - rect.left) / rect.width, 0, 1),
      clamp((ev.clientY - rect.top) / rect.height, 0, 1),
    ];
  }

  onFramePointerDown(ev: PointerEvent): void {
    if (this.mode === 'draw') {
      ev.preventDefault();
      const p = this.framePoint(ev);
      if (p) {
        this.drawDraft = [p];
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      }
    } else if (this.mode === 'poly') {
      ev.preventDefault();
      const p = this.framePoint(ev);
      if (p) this.polyDraft = [...this.polyDraft, p];
    }
  }

  onFramePointerMove(ev: PointerEvent): void {
    if (this.mode !== 'draw' || !this.drawDraft.length) return;
    const p = this.framePoint(ev);
    if (!p) return;
    const last = this.drawDraft[this.drawDraft.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= DRAW_MIN_STEP) {
      this.drawDraft = [...this.drawDraft, p];
    }
  }

  onFramePointerUp(): void {
    if (this.mode !== 'draw' || this.drawDraft.length < 2) {
      this.drawDraft = [];
      return;
    }
    this.finishStroke('freehand', this.drawDraft);
    this.drawDraft = [];
    // El modo dibujo sigue activo: cada trazo es un elemento independiente.
  }

  /** Cierra el polígono en curso (doble clic o botón Terminar). */
  finishPolygon(): void {
    if (this.polyDraft.length >= 3) {
      this.finishStroke('polygon', this.polyDraft);
    }
    this.polyDraft = [];
    this.polygonFinished.emit();
  }

  /** Convierte puntos del marco en un elemento con caja + puntos relativos (y arriba). */
  private finishStroke(type: 'freehand' | 'polygon', framePoints: number[][]): void {
    const xs = framePoints.map((p) => p[0]);
    const ys = framePoints.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const width = Math.max(Math.max(...xs) - minX, 0.01);
    const height = Math.max(Math.max(...ys) - minY, 0.01);
    const points = framePoints.map((p) => [
      round((p[0] - minX) / width),
      round(1 - (p[1] - minY) / height),  // flip a convención PDF (y arriba)
    ]);
    const el = createElement(this.page, {
      type, points, width, height,
      color: STROKE_COLOR, strokeWidth: 2.5,
    });
    // createElement centra el elemento: recolocarlo donde se dibujó de verdad.
    el.left = minX;
    el.top = minY;
    this.elements.push(el);
    this.select(el);
    this.elementsChange.emit(this.elements);
  }

  // --- helpers de dibujo del SVG ---

  /** Puntos del trazo como atributo points de SVG (viewBox 0-100, y abajo). */
  svgPoints(el: MarkupElement): string {
    return (el.points ?? [])
      .map((p) => `${(p[0] * 100).toFixed(1)},${((1 - p[1]) * 100).toFixed(1)}`)
      .join(' ');
  }

  /** Puntos del draft (marco) como points de SVG en porcentaje del marco. */
  draftPoints(points: number[][]): string {
    return points.map((p) => `${(p[0] * 100).toFixed(2)},${(p[1] * 100).toFixed(2)}`).join(' ');
  }

  /** viewBox proporcional a los píxeles de la caja (para arcos sin distorsión). */
  cloudView(el: MarkupElement): string {
    return `0 0 ${this.cloudW(el).toFixed(1)} ${this.cloudH(el).toFixed(1)}`;
  }

  cloudW(el: MarkupElement): number {
    return Math.max(1, el.width * (this.frameWidth ?? 600));
  }

  cloudH(el: MarkupElement): number {
    return Math.max(1, el.height * (this.frameWidth ?? 600) * this.pageAspect);
  }

  /** Path de la nube: semicírculos hacia afuera por el perímetro (px de la caja). */
  cloudPath(el: MarkupElement): string {
    const w = this.cloudW(el);
    const h = this.cloudH(el);
    const r = Math.max(4, Math.min(Math.min(w, h) / 6, 14));
    const nx = Math.max(2, Math.round(w / (2 * r)));
    const ny = Math.max(2, Math.round(h / (2 * r)));
    const sx = w / nx;
    const sy = h / ny;
    const parts: string[] = [];
    for (let i = 0; i < nx; i++) {
      const x0 = i * sx;
      parts.push(`M ${x0} 0 A ${sx / 2} ${r} 0 0 1 ${x0 + sx} 0`);        // arriba
      parts.push(`M ${x0} ${h} A ${sx / 2} ${r} 0 0 0 ${x0 + sx} ${h}`);  // abajo
    }
    for (let j = 0; j < ny; j++) {
      const y0 = j * sy;
      parts.push(`M 0 ${y0} A ${r} ${sy / 2} 0 0 0 0 ${y0 + sy}`);        // izquierda
      parts.push(`M ${w} ${y0} A ${r} ${sy / 2} 0 0 1 ${w} ${y0 + sy}`);  // derecha
    }
    return parts.join(' ');
  }

  /** Posición del tip de la llamada en % RELATIVOS a la caja (puede salirse). */
  tipLeftPct(el: MarkupElement): number {
    return (((el.tipX ?? 0) - el.left) / el.width) * 100;
  }

  tipTopPct(el: MarkupElement): number {
    return (((el.tipY ?? 0) - el.top) / el.height) * 100;
  }

  stampDate(): string {
    return stampPreviewDate();
  }
}
