import { PdfEdit } from '../../core/services/api.service';
import { newId } from '../uuid';

/**
 * Modelo del marcado sobre una página, compartido por el editor clásico
 * (/editor) y el Estudio. Vive en shared/ porque tener DOS implementaciones del
 * mismo lienzo fue el problema que el Estudio viene a resolver.
 */

export type ShapeType =
  | 'highlight' | 'underline' | 'strikeout' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'mark'
  | 'freehand' | 'polygon' | 'cloud' | 'callout' | 'stamp';
export type ElementType = 'text' | 'image' | 'whiteout' | ShapeType;
export type MarkKind = 'cross' | 'check' | 'dot';
/** Modo de interacción sobre la página: seleccionar, trazar o poner vértices. */
export type CanvasMode = 'select' | 'draw' | 'poly';

/** Formas de marcado: se envían con color/grosor de trazo. */
export const SHAPE_TYPES: readonly ShapeType[] = [
  'highlight', 'underline', 'strikeout', 'line', 'arrow', 'rect', 'ellipse', 'mark',
  'freehand', 'polygon', 'cloud', 'callout', 'stamp',
];

export const HIGHLIGHT_COLOR = '#FFDE21';
export const STROKE_COLOR = '#B42318';
export const CHECK_COLOR = '#027A48';
export const STAMP_PRESETS = ['AUTORIZADO', 'PAGADO', 'RECIBIDO', 'ANULADO'] as const;
/** Distancia mínima entre puntos capturados del trazo (fracción del marco). */
export const DRAW_MIN_STEP = 0.004;

export const TYPE_LABELS: Record<ElementType, string> = {
  text: 'Texto', image: 'Imagen', whiteout: 'Tapar y escribir',
  highlight: 'Resaltado', underline: 'Subrayado', strikeout: 'Tachado',
  line: 'Línea', arrow: 'Flecha', rect: 'Recuadro', ellipse: 'Círculo', mark: 'Marca',
  freehand: 'Dibujo libre', polygon: 'Polígono', cloud: 'Nube',
  callout: 'Llamada de texto', stamp: 'Sello',
};

/**
 * Un elemento colocado sobre el PDF. Fracciones con origen ARRIBA-izquierda
 * (como en pantalla); se convierten a la convención PDF al enviar.
 */
export interface MarkupElement {
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

/** Id de un elemento del lienzo. Solo vive en el cliente (nunca se envía). */
export const uid = (): string => newId();

export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export const round = (v: number): number => Math.round(v * 10000) / 10000;

export function isShape(el: MarkupElement): boolean {
  return (SHAPE_TYPES as readonly string[]).includes(el.type);
}

export function typeLabel(el: MarkupElement): string {
  return TYPE_LABELS[el.type] ?? el.type;
}

/** Alto/ancho natural de una imagen, para que no se deforme al colocarla. */
export function imageAspect(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalHeight / img.naturalWidth);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Crea un elemento centrado en la página con los valores por defecto de su tipo.
 * `partial` gana sobre los defaults.
 */
export function createElement(
  page: number,
  partial: Partial<MarkupElement> & { type: ElementType },
): MarkupElement {
  const width = partial.width ?? 0.3;
  const height = partial.height ?? 0.05;
  return {
    id: uid(),
    page,
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
}

/**
 * Traduce los elementos de pantalla al contrato `edits` del backend, y recoge
 * aparte los ficheros de imagen (que viajan como multipart y se referencian por
 * índice). El flip de `y` es la única conversión de convención: en pantalla el
 * origen está arriba y en el PDF, abajo.
 */
export function elementsToEdits(elements: MarkupElement[]): { edits: PdfEdit[]; images: File[] } {
  const images: File[] = [];
  const edits: PdfEdit[] = elements.map((el) => {
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
      return {
        ...base, type: 'whiteout', text: el.text, font_size: el.fontSize,
        color: el.color, color_text: el.textColor,
      };
    }
    if (isShape(el)) {
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
  return { edits, images };
}

/** Fecha de VISTA PREVIA del sello (la real la pone el servidor al procesar). */
export function stampPreviewDate(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()} ${p(now.getHours())}:${p(now.getMinutes())}`;
}
