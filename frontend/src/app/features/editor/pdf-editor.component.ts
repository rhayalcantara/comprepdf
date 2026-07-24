import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, finalize, interval, switchMap, takeWhile } from 'rxjs';

import { ApiService, PdfEdit } from '../../core/services/api.service';
import { PdfDocHandle, PdfPreviewService } from '../../shared/pdf-preview/pdf-preview.service';

type ShapeType = 'highlight' | 'underline' | 'strikeout' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'mark'
  | 'freehand' | 'polygon' | 'cloud' | 'callout' | 'stamp';
type ElementType = 'text' | 'image' | 'whiteout' | ShapeType;
type MarkKind = 'cross' | 'check' | 'dot';
/** Modo de interacción sobre la página: seleccionar, trazar o poner vértices. */
type CanvasMode = 'select' | 'draw' | 'poly';

/** Formas de marcado (Fases 1 y 2): se envían con color/grosor de trazo. */
const SHAPE_TYPES: readonly ShapeType[] = [
  'highlight', 'underline', 'strikeout', 'line', 'arrow', 'rect', 'ellipse', 'mark',
  'freehand', 'polygon', 'cloud', 'callout', 'stamp',
];

const HIGHLIGHT_COLOR = '#FFDE21';
const STROKE_COLOR = '#B42318';
const CHECK_COLOR = '#027A48';
const STAMP_PRESETS = ['AUTORIZADO', 'PAGADO', 'RECIBIDO', 'ANULADO'] as const;
/** Distancia mínima entre puntos capturados del trazo (fracción del marco). */
const DRAW_MIN_STEP = 0.004;

const TYPE_LABELS: Record<ElementType, string> = {
  text: 'Texto', image: 'Imagen', whiteout: 'Tapar y escribir',
  highlight: 'Resaltado', underline: 'Subrayado', strikeout: 'Tachado',
  line: 'Línea', arrow: 'Flecha', rect: 'Recuadro', ellipse: 'Círculo', mark: 'Marca',
  freehand: 'Dibujo libre', polygon: 'Polígono', cloud: 'Nube',
  callout: 'Llamada de texto', stamp: 'Sello',
};

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
  /** Grosor del trazo en puntos (solo formas). */
  strokeWidth: number;
  /** Diagonal que traza line/arrow. */
  dir: 'up' | 'down';
  /** Subtipo de la marca rápida. */
  mark: MarkKind;
  /** Puntos del trazo normalizados a la caja, y hacia ARRIBA (freehand/polygon). */
  points?: number[][];
  /** Punta de la flecha de la llamada, fracciones de página con origen arriba. */
  tipX?: number;
  tipY?: number;
  /** El sello incluye la fecha-hora (la pone el servidor al procesar). */
  showDatetime?: boolean;
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
  /** Nivel de zoom del documento (1 = ajustado al ancho de la columna). */
  zoom = 1;
  /** Ancho en px del marco de la página (ancho base de la columna × zoom). */
  frameWidth: number | null = null;

  elements: EditorElement[] = [];
  selectedId = '';
  busy = false;
  statusMessage = '';
  errorMessage = '';

  private renderSeq = 0;
  private pollSub?: Subscription;
  private drag: {
    kind: 'move' | 'resize' | 'tip';
    el: EditorElement;
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
    // Ancho base = la columna (no el marco: el marco crece con el zoom).
    const column = this.frameRef?.nativeElement.parentElement;
    const base = Math.min(column?.clientWidth || 680, 900);
    const width = Math.round(base * this.zoom);
    try {
      await this.doc.render(this.currentPage, canvas, width);
      if (seq !== this.renderSeq) return;
      this.frameWidth = width;
      if (canvas.width > 0) this.pageAspect = canvas.height / canvas.width;
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

  // --- crear / borrar elementos ---

  addText(): void {
    this.add({ type: 'text', text: 'Texto', width: 0.3, height: 0.05 });
  }

  addWhiteout(): void {
    this.add({ type: 'whiteout', text: '', width: 0.25, height: 0.03 });
  }

  // --- Fase 1: marcado, formas y marcas rápidas ---

  isShape(el: EditorElement): boolean {
    return (SHAPE_TYPES as readonly string[]).includes(el.type);
  }

  typeLabel(el: EditorElement): string {
    return TYPE_LABELS[el.type] ?? el.type;
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

  // --- Fase 2: dibujo libre, polígono, nube, llamada y sellos ---

  mode: CanvasMode = 'select';
  readonly stampPresets = STAMP_PRESETS;
  /** Trazo en curso (dibujo libre), en fracciones del marco, origen arriba. */
  drawDraft: number[][] = [];
  /** Vértices del polígono en curso, en fracciones del marco, origen arriba. */
  polyDraft: number[][] = [];

  toggleMode(mode: CanvasMode): void {
    this.mode = this.mode === mode ? 'select' : mode;
    this.drawDraft = [];
    this.polyDraft = [];
    if (this.mode !== 'select') this.selectedId = '';
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
    this.mode = 'select';
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
    this.add({
      type, points, width, height,
      color: STROKE_COLOR, strokeWidth: 2.5,
    });
    // add() centra el elemento: recolocarlo donde se dibujó de verdad.
    const el = this.elements[this.elements.length - 1];
    el.left = minX;
    el.top = minY;
  }

  // --- SVG del preview ---

  /** Puntos del trazo como atributo points de SVG (viewBox 0-100, y abajo). */
  svgPoints(el: EditorElement): string {
    return (el.points ?? [])
      .map((p) => `${(p[0] * 100).toFixed(1)},${((1 - p[1]) * 100).toFixed(1)}`)
      .join(' ');
  }

  /** Puntos del draft (marco) como points de SVG en porcentaje del marco. */
  draftPoints(points: number[][]): string {
    return points.map((p) => `${(p[0] * 100).toFixed(2)},${(p[1] * 100).toFixed(2)}`).join(' ');
  }

  /** viewBox proporcional a los píxeles de la caja (para arcos sin distorsión). */
  cloudView(el: EditorElement): string {
    return `0 0 ${this.cloudW(el).toFixed(1)} ${this.cloudH(el).toFixed(1)}`;
  }

  cloudW(el: EditorElement): number {
    return Math.max(1, el.width * (this.frameWidth ?? 600));
  }

  cloudH(el: EditorElement): number {
    return Math.max(1, el.height * (this.frameWidth ?? 600) * this.pageAspect);
  }

  /** Path de la nube: semicírculos hacia afuera por el perímetro (px de la caja). */
  cloudPath(el: EditorElement): string {
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
  tipLeftPct(el: EditorElement): number {
    return (((el.tipX ?? 0) - el.left) / el.width) * 100;
  }

  tipTopPct(el: EditorElement): number {
    return (((el.tipY ?? 0) - el.top) / el.height) * 100;
  }

  /** Fecha de VISTA PREVIA del sello (la real la pone el servidor al procesar). */
  stampDate(): string {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()} ${p(now.getHours())}:${p(now.getMinutes())}`;
  }

  /** Zoom con Ctrl+rueda, manteniendo el punto bajo el cursor. */
  async onWheel(ev: WheelEvent): Promise<void> {
    if (!ev.ctrlKey || !this.doc) return;
    ev.preventDefault();
    const scroll = (ev.currentTarget as HTMLElement);
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
      strokeWidth: 2,
      dir: 'up',
      mark: 'check',
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

  startDrag(ev: PointerEvent, el: EditorElement, kind: 'move' | 'resize' | 'tip'): void {
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
      if (this.isShape(el)) {
        const shape: PdfEdit = {
          ...base, type: el.type as PdfEdit['type'],
          color: el.color, stroke_width: el.strokeWidth,
        };
        if (el.type === 'line' || el.type === 'arrow') shape.dir = el.dir;
        if (el.type === 'mark') shape.mark = el.mark;
        if (el.type === 'freehand' || el.type === 'polygon') shape.points = el.points ?? [];
        if (el.type === 'callout') {
          shape.text = el.text;
          shape.font_size = el.fontSize;
          // El tip viaja en convención PDF (y hacia arriba).
          shape.tip = [round(el.tipX ?? 0), round(1 - (el.tipY ?? 0))];
        }
        if (el.type === 'stamp') {
          shape.text = el.text;
          shape.show_datetime = !!el.showDatetime;
        }
        return shape;
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
