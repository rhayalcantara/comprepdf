import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { PdfDocHandle } from '../../shared/pdf-preview/pdf-preview.service';

/**
 * Colocación normalizada de la firma (convención PDF, esquina inferior-izquierda):
 * x, y ∈ [0,1]; w ∈ (0,1]. La altura NO se envía: el worker la deriva del
 * aspect ratio de la imagen.
 */
export interface SignaturePlacement {
  x: number;
  y: number;
  w: number;
}

/** Ancho mínimo del recuadro como fracción del ancho de página. */
const MIN_W = 0.05;

// Proporciones del sello respecto al ANCHO del recuadro. Son las mismas
// constantes que usa el worker (`sign.py`, STAMP_*): si cambias una, cambia la
// otra o la vista previa dejará de coincidir con el PDF. Aquí no se aplican los
// topes en puntos (STAMP_FONT_MIN/MAX) porque en pantalla se trabaja en px.
const STAMP_FONT_RATIO = 0.11;
const STAMP_LEADING = 1.3;
const STAMP_PADDING_RATIO = 0.4;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Página del PDF a tamaño grande con un recuadro arrastrable y redimensionable
 * que muestra la firma. El recuadro mantiene SIEMPRE el aspect ratio de la
 * imagen (la altura se deriva de w · imgH/imgW). Trabaja internamente en
 * fracciones con origen arriba-izquierda y emite coordenadas PDF
 * (origen abajo-izquierda) vía `placementChange`.
 */
@Component({
  selector: 'app-sign-placement',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="place-frame" #frame>
      <canvas #pageCanvas [style.visibility]="rendered() ? 'visible' : 'hidden'"></canvas>
      @if (!rendered()) {
        <span class="place-ph mono">{{ page() }}</span>
      }
      @if (imageUrl() && rendered()) {
        <div class="sig-box"
             role="img"
             aria-label="Posición de la firma (arrastra para mover)"
             [style.left.%]="leftFrac() * 100"
             [style.top.%]="topFrac() * 100"
             [style.width.%]="widthFrac() * 100"
             [style.height.%]="heightFrac() * 100"
             (pointerdown)="startDrag($event, 'move')"
             (pointermove)="onDragMove($event)"
             (pointerup)="endDrag()"
             (pointercancel)="endDrag()">
          <span class="sig-img" [style.height.%]="imagePct()">
            <img [src]="imageUrl()" alt="Firma" draggable="false">
          </span>
          @if (stampLines().length) {
            <span class="sig-stamp"
                  [class.bordered]="stampBorder()"
                  [style.height.%]="100 - imagePct()"
                  [style.color]="stampColor()"
                  [style.border-color]="stampColor()"
                  [style.font-size.px]="stampFontPx()">
              @for (line of stampLines(); track $index) {
                <span class="sig-stamp-line">{{ line }}</span>
              }
            </span>
          }
          <span class="sig-handle"
                aria-label="Redimensionar firma"
                (pointerdown)="startDrag($event, 'resize')"
                (pointermove)="onDragMove($event)"
                (pointerup)="endDrag()"
                (pointercancel)="endDrag()"></span>
        </div>
      }
    </div>
  `,
  styles: [`
    .place-frame {
      position: relative;
      min-height: 220px;
      background: var(--mist);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }

    canvas {
      display: block;
      width: 100%;
      height: auto;
    }

    .place-ph {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #9aa7ba;
      font-size: 1.1rem;
    }

    .sig-box {
      position: absolute;
      border: 1.5px dashed var(--cobalt);
      border-radius: 2px;
      background: rgba(46, 91, 255, 0.06);
      cursor: move;
      touch-action: none;
      user-select: none;
    }

    .sig-box {
      display: flex;
      flex-direction: column;
    }

    .sig-img { display: block; min-height: 0; }

    .sig-box img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
      user-select: none;
    }

    /* El sello ocupa la parte baja del recuadro, igual que en el PDF. */
    .sig-stamp {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 0;
      overflow: hidden;
      font-weight: 700;
      line-height: 1.3;
      white-space: nowrap;
      pointer-events: none;
      user-select: none;
      box-sizing: border-box;
    }

    .sig-stamp.bordered { border: 1px solid currentColor; }

    .sig-stamp-line { overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

    .sig-handle {
      position: absolute;
      right: -8px;
      bottom: -8px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--cobalt);
      border: 2px solid #fff;
      box-shadow: 0 1px 3px rgba(18, 35, 63, 0.3);
      cursor: nwse-resize;
      touch-action: none;
    }
  `],
})
export class SignPlacementComponent {
  doc = input.required<PdfDocHandle>();
  /** Página de referencia (1-based). */
  page = input.required<number>();
  /** Imagen de la firma (dataURL u objectURL); null = sin overlay. */
  imageUrl = input<string | null>(null);
  /** Aspect ratio alto/ancho de la imagen de la firma. */
  imageAspect = input(0.5);
  /** Líneas del sello bajo la firma; vacío = sin sello. */
  stampLines = input<string[]>([]);
  stampColor = input('#B42318');
  stampBorder = input(true);
  placementChange = output<SignaturePlacement>();

  // Fracciones con origen arriba-izquierda relativas a la página mostrada.
  leftFrac = signal(0.55);
  topFrac = signal(0.72);
  widthFrac = signal(0.3);
  /** Aspect ratio alto/ancho de la PÁGINA (del canvas renderizado). */
  pageAspect = signal(Math.SQRT2);
  rendered = signal(false);

  /** Ancho de la página renderizada en px, para dimensionar la letra del sello. */
  private frameW = signal(600);

  /** Alto de la imagen sola, en fracción del alto de página. */
  private imageHeightFrac = computed(() =>
    this.widthFrac() * this.imageAspect() / this.pageAspect());

  /**
   * Alto del sello en fracción del alto de página. Se deriva del ANCHO del
   * recuadro con las mismas proporciones que el worker, por eso escala con la
   * firma al redimensionarla.
   */
  private stampHeightFrac = computed(() => {
    const n = this.stampLines().length;
    if (!n) return 0;
    const enAnchos = STAMP_FONT_RATIO * (2 * STAMP_PADDING_RATIO + n * STAMP_LEADING);
    return this.widthFrac() * enAnchos / this.pageAspect();
  });

  /** Alto del CONJUNTO firma + sello (lo que se arrastra y se envía). */
  heightFrac = computed(() => this.imageHeightFrac() + this.stampHeightFrac());

  /** Reparto vertical dentro del recuadro: qué % ocupa la imagen. */
  imagePct = computed(() => {
    const total = this.heightFrac();
    return total > 0 ? (this.imageHeightFrac() / total) * 100 : 100;
  });

  stampFontPx = computed(() => this.widthFrac() * this.frameW() * STAMP_FONT_RATIO);

  @ViewChild('pageCanvas', { static: true }) private canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('frame', { static: true }) private frameRef!: ElementRef<HTMLDivElement>;

  private renderSeq = 0;
  private drag: {
    kind: 'move' | 'resize';
    startX: number;
    startY: number;
    left: number;
    top: number;
    width: number;
    frameW: number;
    frameH: number;
  } | null = null;

  constructor() {
    // Re-render al cambiar documento o página (escribe `rendered`/`pageAspect`).
    effect(() => {
      void this.renderPage(this.doc(), this.page());
    }, { allowSignalWrites: true });
    // Si cambia el aspect ratio (nueva firma / nueva página), mantener el
    // recuadro dentro de la página.
    // Si cambia el aspect ratio o el sello (que suma altura), mantener el
    // recuadro dentro de la página.
    effect(() => {
      this.imageAspect();
      this.pageAspect();
      this.stampLines();
      this.clampBox();
    }, { allowSignalWrites: true });
    // Emitir la colocación en coordenadas PDF cada vez que cambia.
    effect(() => {
      const y = clamp(1 - this.topFrac() - this.heightFrac(), 0, 1);
      this.placementChange.emit({
        x: clamp(this.leftFrac(), 0, 1),
        y,
        w: clamp(this.widthFrac(), MIN_W, 1),
      });
    });
  }

  private async renderPage(doc: PdfDocHandle, page: number): Promise<void> {
    const seq = ++this.renderSeq;
    this.rendered.set(false);
    const canvas = this.canvasRef.nativeElement;
    const width = Math.min(this.frameRef.nativeElement.clientWidth || 620, 900);
    try {
      await doc.render(page, canvas, width);
      if (seq !== this.renderSeq) return;
      if (canvas.width > 0 && canvas.height > 0) {
        this.pageAspect.set(canvas.height / canvas.width);
      }
      this.frameW.set(canvas.clientWidth || width);
      this.rendered.set(true);
    } catch {
      if (seq === this.renderSeq) this.rendered.set(false);
    }
  }

  /** Alto del conjunto (imagen + sello) por unidad de ancho del recuadro. */
  private heightPerWidth(): number {
    const n = this.stampLines().length;
    const stamp = n ? STAMP_FONT_RATIO * (2 * STAMP_PADDING_RATIO + n * STAMP_LEADING) : 0;
    return this.imageAspect() + stamp;
  }

  /** Máximo ancho posible sin que la altura derivada se salga de la página. */
  private maxWidthFrac(): number {
    const byHeight = this.pageAspect() / this.heightPerWidth();
    return Math.min(1, byHeight);
  }

  private clampBox(): void {
    const w = clamp(this.widthFrac(), MIN_W, this.maxWidthFrac());
    this.widthFrac.set(w);
    const h = w * this.heightPerWidth() / this.pageAspect();
    this.leftFrac.set(clamp(this.leftFrac(), 0, 1 - w));
    this.topFrac.set(clamp(this.topFrac(), 0, Math.max(0, 1 - h)));
  }

  startDrag(ev: PointerEvent, kind: 'move' | 'resize'): void {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = this.frameRef.nativeElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.drag = {
      kind,
      startX: ev.clientX,
      startY: ev.clientY,
      left: this.leftFrac(),
      top: this.topFrac(),
      width: this.widthFrac(),
      frameW: rect.width,
      frameH: rect.height,
    };
  }

  onDragMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = (ev.clientX - d.startX) / d.frameW;
    const dy = (ev.clientY - d.startY) / d.frameH;
    if (d.kind === 'move') {
      const h = this.heightFrac();
      this.leftFrac.set(clamp(d.left + dx, 0, 1 - this.widthFrac()));
      this.topFrac.set(clamp(d.top + dy, 0, Math.max(0, 1 - h)));
    } else {
      const maxW = Math.min(1 - d.left, this.maxWidthFrac());
      this.widthFrac.set(clamp(d.width + dx, MIN_W, maxW));
      // Si al crecer la altura se sale por abajo, subir el recuadro.
      const h = this.heightFrac();
      if (d.top + h > 1) this.topFrac.set(Math.max(0, 1 - h));
    }
  }

  endDrag(): void {
    this.drag = null;
  }
}
