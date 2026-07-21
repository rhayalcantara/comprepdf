import { Component, ElementRef, OnDestroy, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import SignaturePad from 'signature_pad';
import type { PointGroup } from 'signature_pad';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Observable, interval, switchMap, takeWhile } from 'rxjs';
import { ApiService, ApiResponse, JobResponse, SignStamp } from '../../core/services/api.service';
import { ToolDef, findTool } from '../../core/tool-catalog';
import { PdfDocHandle, PdfPreviewService } from '../../shared/pdf-preview/pdf-preview.service';
import { PdfPageGridComponent } from '../../shared/pdf-preview/pdf-page-grid.component';
import { PdfThumbComponent } from '../../shared/pdf-preview/pdf-thumb.component';
import {
  PageRange,
  chunkIntoRanges,
  formatPageSpec,
  isValidRange,
  parsePageSpec,
  rangesToSpec,
} from '../../shared/pdf-preview/page-ranges';
import { SignPlacementComponent, SignaturePlacement } from './sign-placement.component';
import { MergeBuilderComponent, MergeEntry } from './merge-builder.component';

type SingleFileField = 'splitFile' | 'extractFile' | 'rotateFile' | 'protectFile' | 'unlockFile' | 'signFile' | 'signCert' | 'convertFile' | 'pdfToWordFile';

/** Extensiones que acepta la conversión a PDF (espejo del backend, uploadConvert). */
const CONVERT_EXTENSIONS = [
  '.doc', '.docx', '.rtf', '.odt', '.txt',
  '.xls', '.xlsx', '.ods',
  '.ppt', '.pptx', '.odp',
  '.jpg', '.jpeg', '.png',
];

/** Herramientas con previsualización de páginas (pdf.js). */
const PREVIEW_TOOLS = ['split', 'extract', 'rotate', 'sign'];

/** Colores de tinta del lienzo de firma. */
const INK_HEX = { black: '#000000', blue: '#1e40af' } as const;

/** Mismo patrón de páginas que valida el backend ("2", "1,3-5", ...). */
const SIGN_PAGES_PATTERN = /^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/;

/** Límite de la imagen de firma subida (el backend rechaza > 2MB). */
const SIGN_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Etiquetas de sello más habituales (el texto sigue siendo libre). */
const STAMP_PRESETS = ['AUTORIZADO', 'CANCELADO', 'ANULADO', 'RECIBIDO', 'PAGADO', 'REVISADO'];

/** Paleta del sello (el backend acepta cualquier hex; esto son los atajos). */
const STAMP_COLORS = [
  { name: 'Rojo', hex: '#B42318' },
  { name: 'Verde', hex: '#027A48' },
  { name: 'Azul', hex: '#1D4ED8' },
  { name: 'Negro', hex: '#101828' },
] as const;

/** Mismo tope que el backend (`MAX_STAMP_TEXT`). */
const MAX_STAMP_TEXT = 60;

/** dd/mm/aaaa [hh:mm] — mismo formato que produce el worker. */
function formatStampDate(format: 'datetime' | 'date'): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const fecha = `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()}`;
  return format === 'date' ? fecha : `${fecha} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** dataURL (base64) → Blob, para enviar el PNG del canvas por multipart. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Recorta el canvas al bounding box de los píxeles con tinta (más un margen).
 * Así el recuadro de colocación coincide con la firma real y no con todo el
 * lienzo. Devuelve null si el canvas está vacío.
 */
function trimCanvas(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = source.getContext('2d');
  if (!ctx || !source.width || !source.height) return null;
  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

@Component({
  selector: 'app-tools',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    MatProgressBarModule,
    MatSnackBarModule,
    PdfPageGridComponent,
    PdfThumbComponent,
    SignPlacementComponent,
    MergeBuilderComponent,
  ],
  templateUrl: './tools.component.html',
  styleUrl: './tools.component.scss',
})
export class ToolsComponent implements OnDestroy {
  tool = signal<ToolDef | null>(null);
  toolId = computed(() => this.tool()?.id ?? '');

  // Estado compartido del trabajo en curso (una operación a la vez)
  currentJob = signal<JobResponse | null>(null);
  isProcessing = signal(false);
  isDragging = signal(false);

  /** Nombre opcional del archivo resultante (sin extensión), común a todas las herramientas. */
  outputName = '';

  // --- Previsualización (split/extract/rotate) ---
  previewDoc = signal<PdfDocHandle | null>(null);
  previewStatus = signal<'idle' | 'loading' | 'ready' | 'password' | 'error'>('idle');
  pageCount = computed(() => this.previewDoc()?.pageCount ?? 0);
  hasPreview = computed(() => this.previewStatus() === 'ready');
  /** Layout ancho de 2 columnas cuando hay archivo en una herramienta con preview.
   *  Para 'sign' solo en los modos con colocación visual (drawn/combined). */
  wideLayout = computed(() => {
    if (!this.hasMainFile() || !PREVIEW_TOOLS.includes(this.toolId())) return false;
    return this.toolId() !== 'sign' || this.signMode() !== 'certificate';
  });
  private hasMainFile = signal(false);

  // Split
  splitFile: File | null = null;
  splitMode = signal<'ranges' | 'fixed' | 'individual'>('ranges');
  splitRangesList = signal<PageRange[]>([{ from: 1, to: 1 }]);
  splitFixedSize = signal(1);
  splitMergeOne = signal(false);
  /** Fallback de texto cuando no hay preview (PDF con contraseña, etc.). */
  splitRangesFallback = '';
  splitEffectiveRanges = computed<PageRange[]>(() => {
    switch (this.splitMode()) {
      case 'fixed':
        return chunkIntoRanges(this.pageCount(), Math.max(1, this.splitFixedSize()));
      case 'ranges':
        return this.splitRangesList();
      default:
        return [];
    }
  });

  // Merge — el orden y las páginas por archivo los gestiona MergeBuilderComponent
  mergeEntries: MergeEntry[] = [];

  // Extract
  extractFile: File | null = null;
  extractPagesInput = '';
  extractSelection = signal<ReadonlySet<number>>(new Set<number>());

  // Rotate
  rotateFile: File | null = null;
  rotateDegrees = 90;
  rotatePagesInput = 'all';
  rotateScope = signal<'all' | 'custom'>('all');
  rotateSelection = signal<ReadonlySet<number>>(new Set<number>());

  // Protect
  protectFile: File | null = null;
  protectPassword = '';

  // Unlock
  unlockFile: File | null = null;
  unlockPassword = '';

  // Convert
  convertFile: File | null = null;

  // PDF a Word
  pdfToWordFile: File | null = null;

  // Sign
  signFile: File | null = null;
  signCert: File | null = null;
  signPassword = '';
  signReason = '';
  signLocation = '';
  signMode = signal<'certificate' | 'drawn' | 'combined'>('certificate');
  /** Origen de la imagen de firma: dibujada en el lienzo o subida. */
  signSource = signal<'draw' | 'upload'>('draw');
  signInk = signal<'black' | 'blue'>('black');
  signPagesScope = signal<'current' | 'all' | 'range'>('current');
  signPagesRange = '';
  /** Página de referencia visible en el visor de colocación (1-based). */
  signCurrentPage = signal(1);
  /** Última colocación emitida por el overlay (coordenadas PDF normalizadas). */
  signPlacement: SignaturePlacement | null = null;
  signUploadFile: File | null = null;
  private signUploadUrl = signal<string | null>(null);
  private signUploadAspect = signal(0.75);
  /** PNG (dataURL) del dibujo recortado al bounding box de la tinta. */
  signDrawnUrl = signal<string | null>(null);
  private signDrawnAspect = signal(0.5);
  /** Imagen de firma activa según el origen elegido. */
  signImageUrl = computed(() =>
    this.signSource() === 'draw' ? this.signDrawnUrl() : this.signUploadUrl());
  signImageAspect = computed(() =>
    this.signSource() === 'draw' ? this.signDrawnAspect() : this.signUploadAspect());

  // Sello de texto bajo la firma (drawn/combined). La fecha la pone el worker
  // al procesar: aquí solo se elige si se incluye y con qué formato.
  signStampOn = signal(false);
  signStampText = signal('');
  signStampDatetime = signal(true);
  signStampFormat = signal<'datetime' | 'date'>('datetime');
  signStampColor = signal<string>(STAMP_COLORS[0].hex);
  signStampBorder = signal(true);
  readonly stampPresets = STAMP_PRESETS;
  readonly stampColors = STAMP_COLORS;

  /** Líneas que se verán en el PDF; alimenta también la vista previa. */
  signStampLines = computed<string[]>(() => {
    if (!this.signStampOn()) return [];
    const lines: string[] = [];
    const text = this.signStampText().replace(/[\r\n]+/g, ' ').trim();
    if (text) lines.push(text.slice(0, MAX_STAMP_TEXT));
    // En la vista previa la fecha es la del navegador; el PDF llevará la del
    // servidor al procesarse (pueden diferir en segundos, no en formato).
    if (this.signStampDatetime()) lines.push(formatStampDate(this.signStampFormat()));
    return lines;
  });

  private signaturePad: SignaturePad | null = null;
  private sigCanvasEl: HTMLCanvasElement | null = null;
  /** Trazos guardados para restaurar el lienzo cuando se re-crea (cambio de pestaña). */
  private padData: PointGroup[] = [];

  /** El canvas vive dentro de @if: el setter gestiona crear/destruir el pad. */
  @ViewChild('sigCanvas')
  set sigCanvas(ref: ElementRef<HTMLCanvasElement> | undefined) {
    if (ref?.nativeElement === this.sigCanvasEl) return;
    this.destroyPad();
    if (ref) this.initPad(ref.nativeElement);
  }

  constructor(
    private api: ApiService,
    private snackBar: MatSnackBar,
    private pdfPreview: PdfPreviewService,
    route: ActivatedRoute,
    router: Router,
  ) {
    route.paramMap.subscribe((params) => {
      const def = findTool(params.get('tool') ?? '');
      if (!def || def.id === 'compress') {
        router.navigateByUrl('/');
        return;
      }
      this.tool.set(def);
      this.currentJob.set(null);
      this.isProcessing.set(false);
      this.outputName = '';
      this.mergeEntries = [];
      // Estado de firma: al cambiar de herramienta se vuelve al modo por defecto
      // y se descartan credenciales y dibujo (datos sensibles).
      this.signMode.set('certificate');
      this.signCert = null;
      this.signPassword = '';
      this.signReason = '';
      this.signLocation = '';
      this.signStampOn.set(false);
      this.signStampText.set('');
      void this.loadPreview(null);
    });
  }

  ngOnDestroy(): void {
    this.destroyPad();
    this.revokeUploadUrl();
    void this.previewDoc()?.destroy();
  }

  /** Archivo principal (PDF) de la herramienta activa */
  mainFile(): File | null {
    switch (this.toolId()) {
      case 'split': return this.splitFile;
      case 'extract': return this.extractFile;
      case 'rotate': return this.rotateFile;
      case 'protect': return this.protectFile;
      case 'unlock': return this.unlockFile;
      case 'sign': return this.signFile;
      case 'convert': return this.convertFile;
      case 'pdf-to-word': return this.pdfToWordFile;
      default: return null;
    }
  }

  /** Tipos aceptados por el input/drop principal (convert no recibe PDFs). */
  mainAccept(): string {
    return this.toolId() === 'convert' ? CONVERT_EXTENSIONS.join(',') : '.pdf';
  }

  /** ¿El archivo es válido para la herramienta actual? (drag & drop) */
  private acceptsMainFile(file: File): boolean {
    if (this.toolId() === 'convert') {
      const name = file.name.toLowerCase();
      return CONVERT_EXTENSIONS.some((ext) => name.endsWith(ext));
    }
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  }

  clearMainFile(): void {
    this.setMainFile(null);
  }

  private setMainFile(file: File | null): void {
    switch (this.toolId()) {
      case 'split': this.splitFile = file; break;
      case 'extract': this.extractFile = file; break;
      case 'rotate': this.rotateFile = file; break;
      case 'protect': this.protectFile = file; break;
      case 'unlock': this.unlockFile = file; break;
      case 'sign': this.signFile = file; break;
      case 'convert': this.convertFile = file; break;
      case 'pdf-to-word': this.pdfToWordFile = file; break;
    }
    this.hasMainFile.set(!!file);
    if (PREVIEW_TOOLS.includes(this.toolId())) {
      void this.loadPreview(file);
    }
  }

  /** Abre el PDF con pdf.js y resetea el estado dependiente del documento. */
  private async loadPreview(file: File | null): Promise<void> {
    await this.previewDoc()?.destroy();
    this.previewDoc.set(null);
    this.extractSelection.set(new Set<number>());
    this.extractPagesInput = '';
    this.rotateSelection.set(new Set<number>());
    this.rotateScope.set('all');
    this.rotatePagesInput = 'all';
    this.splitRangesList.set([{ from: 1, to: 1 }]);
    this.splitFixedSize.set(1);
    this.splitMergeOne.set(false);
    this.splitMode.set('ranges');
    this.resetSignArtwork();
    this.signPagesScope.set('current');
    this.signPagesRange = '';
    this.signCurrentPage.set(1);
    this.signPlacement = null;
    if (!file) {
      this.previewStatus.set('idle');
      this.hasMainFile.set(false);
      return;
    }
    this.previewStatus.set('loading');
    try {
      const doc = await this.pdfPreview.open(file);
      this.previewDoc.set(doc);
      // Rango inicial = documento completo, como iLovePDF.
      this.splitRangesList.set([{ from: 1, to: doc.pageCount }]);
      this.previewStatus.set('ready');
    } catch (e) {
      this.previewStatus.set(e === 'password' ? 'password' : 'error');
    }
  }

  // --- Selección de archivos ---
  pickSingle(event: Event, field: SingleFileField): void {
    const input = event.target as HTMLInputElement;
    this[field] = input.files?.[0] ?? null;
    input.value = '';
  }

  pickMain(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.setMainFile(input.files?.[0] ?? null);
    input.value = '';
  }

  onMergeEntries(entries: MergeEntry[]): void {
    this.mergeEntries = entries;
  }

  // --- Drag & drop sobre la zona principal ---
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
    const files = Array.from(event.dataTransfer?.files ?? [])
      .filter((f) => this.acceptsMainFile(f));
    if (!files.length) {
      return this.warn(this.toolId() === 'convert'
        ? 'Formato no soportado (Word, Excel, PowerPoint, ODF, TXT, RTF, JPG o PNG)'
        : 'Solo se permiten archivos PDF');
    }
    // Merge gestiona su propio drag & drop dentro de MergeBuilderComponent.
    this.setMainFile(files[0]);
  }

  // --- Split: edición de rangos ---
  addSplitRange(): void {
    const last = this.splitRangesList().at(-1);
    const total = this.pageCount();
    const next = Math.min((last?.to ?? 0) + 1, total || Number.MAX_SAFE_INTEGER);
    this.splitRangesList.update((l) => [...l, { from: next, to: total || next }]);
  }

  removeSplitRange(index: number): void {
    this.splitRangesList.update((l) => l.filter((_, i) => i !== index));
  }

  updateSplitRange(index: number, field: 'from' | 'to', rawValue: number | string): void {
    const total = this.pageCount();
    let value = Math.trunc(Number(rawValue));
    if (!Number.isFinite(value)) return;
    value = Math.max(1, total ? Math.min(value, total) : value);
    this.splitRangesList.update((list) =>
      list.map((r, i) => {
        if (i !== index) return r;
        const updated = { ...r, [field]: value };
        // Mantener from <= to arrastrando el otro extremo.
        if (field === 'from' && updated.from > updated.to) updated.to = updated.from;
        if (field === 'to' && updated.to < updated.from) updated.from = updated.to;
        return updated;
      }),
    );
  }

  stepSplitRange(index: number, field: 'from' | 'to', delta: number): void {
    const r = this.splitRangesList()[index];
    if (r) this.updateSplitRange(index, field, r[field] + delta);
  }

  stepFixedSize(delta: number): void {
    const total = this.pageCount() || 1;
    this.splitFixedSize.update((n) => Math.max(1, Math.min(n + delta, total)));
  }

  // --- Extract / Rotate: selección por miniaturas <-> texto ---
  onExtractThumbToggle(page: number): void {
    const next = new Set(this.extractSelection());
    next.has(page) ? next.delete(page) : next.add(page);
    this.extractSelection.set(next);
    this.extractPagesInput = formatPageSpec(next);
  }

  onExtractInputChange(value: string): void {
    this.extractPagesInput = value;
    this.extractSelection.set(new Set(parsePageSpec(value, this.pageCount())));
  }

  normalizeExtractInput(): void {
    this.extractPagesInput = formatPageSpec(this.extractSelection());
  }

  onRotateThumbToggle(page: number): void {
    this.rotateScope.set('custom');
    const next = new Set(this.rotateSelection());
    next.has(page) ? next.delete(page) : next.add(page);
    this.rotateSelection.set(next);
  }

  setRotateScope(scope: 'all' | 'custom'): void {
    this.rotateScope.set(scope);
    if (scope === 'all') this.rotateSelection.set(new Set<number>());
  }

  // --- Sign: lienzo, tinta, imagen subida y colocación ---
  private initPad(canvas: HTMLCanvasElement): void {
    this.sigCanvasEl = canvas;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = (canvas.offsetWidth || 280) * ratio;
    canvas.height = (canvas.offsetHeight || 150) * ratio;
    canvas.getContext('2d')?.scale(ratio, ratio);
    // Fondo transparente (sin backgroundColor): el PNG exportado conserva alfa.
    const pad = new SignaturePad(canvas, { penColor: INK_HEX[this.signInk()] });
    pad.addEventListener('endStroke', this.onEndStroke);
    if (this.padData.length) {
      pad.fromData(this.padData);
    }
    this.signaturePad = pad;
  }

  private destroyPad(): void {
    const pad = this.signaturePad;
    if (!pad) return;
    this.padData = pad.toData();
    pad.removeEventListener('endStroke', this.onEndStroke);
    pad.off();
    this.signaturePad = null;
    this.sigCanvasEl = null;
  }

  private onEndStroke = (): void => this.refreshDrawnImage();

  /** Exporta el dibujo (recortado) a dataURL para el overlay y el envío. */
  private refreshDrawnImage(): void {
    const pad = this.signaturePad;
    const canvas = this.sigCanvasEl;
    if (!pad || !canvas || pad.isEmpty()) {
      this.signDrawnUrl.set(null);
      return;
    }
    const trimmed = trimCanvas(canvas) ?? canvas;
    this.signDrawnUrl.set(trimmed.toDataURL('image/png'));
    this.signDrawnAspect.set(trimmed.height / trimmed.width);
  }

  setSignInk(ink: 'black' | 'blue'): void {
    this.signInk.set(ink);
    if (this.signaturePad) this.signaturePad.penColor = INK_HEX[ink];
  }

  undoSignStroke(): void {
    const pad = this.signaturePad;
    if (!pad) return;
    const data = pad.toData();
    if (!data.length) return;
    data.pop();
    pad.fromData(data);
    this.refreshDrawnImage();
  }

  clearSignPad(): void {
    this.signaturePad?.clear();
    this.padData = [];
    this.signDrawnUrl.set(null);
  }

  onSignImagePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      return this.warn('La firma debe ser una imagen PNG o JPG');
    }
    if (file.size > SIGN_IMAGE_MAX_BYTES) {
      return this.warn('La imagen de la firma no puede superar 2 MB');
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      this.revokeUploadUrl();
      this.signUploadFile = file;
      this.signUploadUrl.set(url);
      this.signUploadAspect.set(img.naturalHeight / Math.max(1, img.naturalWidth));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      this.warn('No se pudo leer la imagen de la firma');
    };
    img.src = url;
  }

  clearSignUpload(): void {
    this.revokeUploadUrl();
    this.signUploadFile = null;
  }

  private revokeUploadUrl(): void {
    const url = this.signUploadUrl();
    if (url) URL.revokeObjectURL(url);
    this.signUploadUrl.set(null);
  }

  /** Limpia dibujo e imagen subida (cambio de archivo o de herramienta). */
  private resetSignArtwork(): void {
    this.signaturePad?.clear();
    this.padData = [];
    this.signDrawnUrl.set(null);
    this.clearSignUpload();
    this.signSource.set('draw');
    this.signInk.set('black');
  }

  onSignPlacement(placement: SignaturePlacement): void {
    this.signPlacement = placement;
  }

  stepSignPage(delta: number): void {
    const total = this.pageCount() || 1;
    this.signCurrentPage.update((p) => Math.min(Math.max(p + delta, 1), total));
  }

  /** Blob de la firma a enviar según el origen activo, o null si no hay. */
  private signatureBlob(): { blob: Blob; filename: string } | null {
    if (this.signSource() === 'upload') {
      return this.signUploadFile
        ? { blob: this.signUploadFile, filename: this.signUploadFile.name }
        : null;
    }
    const url = this.signDrawnUrl();
    return url ? { blob: dataUrlToBlob(url), filename: 'firma.png' } : null;
  }

  /** Resuelve el campo `pages` según el alcance; null = ya se avisó al usuario. */
  private resolveSignPages(): string | null {
    switch (this.signPagesScope()) {
      case 'current':
        return String(this.signCurrentPage());
      case 'all':
        return 'all';
      case 'range': {
        const raw = this.signPagesRange.trim();
        if (!raw) {
          this.warn('Indica las páginas donde estampar (ej: 1,3-5)');
          return null;
        }
        if (!SIGN_PAGES_PATTERN.test(raw)) {
          this.warn('Formato de páginas no válido (ej: 1,3-5)');
          return null;
        }
        const total = this.pageCount();
        const inRange = parsePageSpec(raw, total);
        if (!inRange.length || inRange.length !== parsePageSpec(raw).length) {
          this.warn(`Las páginas deben estar entre 1 y ${total}`);
          return null;
        }
        return raw;
      }
    }
  }

  // --- Ejecución de la operación activa ---
  runCurrent(): void {
    switch (this.toolId()) {
      case 'split': return this.runSplit();
      case 'merge': return this.runMerge();
      case 'sign': return this.runSign();
      case 'extract': return this.runExtract();
      case 'rotate': return this.runRotate();
      case 'protect': return this.runProtect();
      case 'unlock': return this.runUnlock();
      case 'convert': return this.runConvert();
      case 'pdf-to-word': return this.runPdfToWord();
    }
  }

  /** Nombre de salida limpio o undefined (el worker usará el nombre por defecto). */
  private outName(): string | undefined {
    return this.outputName.trim() || undefined;
  }

  private runSplit(): void {
    if (!this.splitFile) return this.warn('Selecciona un PDF');

    if (this.splitMode() === 'individual') {
      return this.run(this.api.splitPdf(this.splitFile, 'individual', undefined, this.outName()));
    }

    // Sin preview (contraseña/error) el editor visual no aplica: usa el texto.
    if (!this.hasPreview()) {
      const spec = this.splitRangesFallback.trim();
      if (!spec) return this.warn('Indica los rangos (ej: 1-3,5,8-10)');
      return this.run(this.api.splitPdf(this.splitFile, 'ranges', spec, this.outName()));
    }

    const ranges = this.splitEffectiveRanges();
    if (!ranges.length) return this.warn('Añade al menos un rango');
    if (ranges.some((r) => !isValidRange(r, this.pageCount()))) {
      return this.warn(`Revisa los rangos: deben estar entre 1 y ${this.pageCount()}`);
    }
    const spec = rangesToSpec(ranges);
    if (this.splitMergeOne()) {
      // "Unir en un solo PDF": extract produce un único PDF con esas páginas.
      this.run(this.api.extractPages(this.splitFile, spec, this.outName()));
    } else {
      this.run(this.api.splitPdf(this.splitFile, 'ranges', spec, this.outName()));
    }
  }

  private runMerge(): void {
    const entries = this.mergeEntries;
    if (entries.length < 2) return this.warn('Selecciona al menos 2 PDFs');

    const ranges: string[] = [];
    for (const e of entries) {
      const spec = e.pages.trim();
      // Sin vista previa (protegido/error) o campo vacío ⇒ documento completo.
      if (!spec || !e.ready) {
        ranges.push('all');
        continue;
      }
      const pages = parsePageSpec(spec, e.pageCount);
      if (!pages.length) {
        return this.warn(`Revisa las páginas de "${e.file.name}" (1–${e.pageCount})`);
      }
      ranges.push(formatPageSpec(pages));
    }

    const files = entries.map((e) => e.file);
    const allComplete = ranges.every((r) => r === 'all');
    this.run(this.api.mergePdfs(files, this.outName(), allComplete ? undefined : ranges));
  }

  private runExtract(): void {
    if (!this.extractFile) return this.warn('Selecciona un PDF');
    if (!this.extractPagesInput.trim()) return this.warn('Indica las páginas (ej: 1-3,5)');
    this.run(this.api.extractPages(this.extractFile, this.extractPagesInput, this.outName()));
  }

  private runRotate(): void {
    if (!this.rotateFile) return this.warn('Selecciona un PDF');
    let pages: string;
    if (this.hasPreview()) {
      pages = this.rotateScope() === 'all' ? 'all' : formatPageSpec(this.rotateSelection());
      if (!pages) return this.warn('Selecciona al menos una página');
    } else {
      pages = this.rotatePagesInput || 'all';
    }
    this.run(this.api.rotatePages(this.rotateFile, this.rotateDegrees, pages, this.outName()));
  }

  private runProtect(): void {
    if (!this.protectFile) return this.warn('Selecciona un PDF');
    if (!this.protectPassword) return this.warn('Indica una contraseña');
    this.run(this.api.protectPdf(this.protectFile, this.protectPassword, undefined, this.outName()));
  }

  private runUnlock(): void {
    if (!this.unlockFile) return this.warn('Selecciona un PDF');
    if (!this.unlockPassword) return this.warn('Indica la contraseña actual');
    this.run(this.api.unlockPdf(this.unlockFile, this.unlockPassword, this.outName()));
  }

  /** Aplica una etiqueta de atajo al texto del sello. */
  useStampPreset(preset: string): void {
    this.signStampText.set(preset);
    this.signStampOn.set(true);
  }

  /**
   * Sello a enviar: `undefined` si está desactivado, `null` si está activado
   * pero no lleva ni etiqueta ni fecha (error: el backend lo rechazaría).
   */
  private buildStamp(): SignStamp | undefined | null {
    if (!this.signStampOn()) return undefined;
    const text = this.signStampText().replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_STAMP_TEXT);
    if (!text && !this.signStampDatetime()) {
      this.warn('El sello necesita un texto o la fecha');
      return null;
    }
    return {
      text,
      show_datetime: this.signStampDatetime(),
      datetime_format: this.signStampFormat(),
      color: this.signStampColor(),
      border: this.signStampBorder(),
    };
  }

  private runConvert(): void {
    if (!this.convertFile) return this.warn('Selecciona un documento');
    this.run(this.api.convertToPdf(this.convertFile, this.outName()));
  }

  private runPdfToWord(): void {
    if (!this.pdfToWordFile) return this.warn('Selecciona un PDF');
    this.run(this.api.pdfToWord(this.pdfToWordFile, this.outName()));
  }

  private runSign(): void {
    if (!this.signFile) return this.warn('Selecciona un PDF');
    const mode = this.signMode();

    if (mode !== 'drawn') {
      if (!this.signCert) return this.warn('Selecciona el certificado (.pfx/.p12)');
      if (!this.signPassword) return this.warn('Indica la contraseña del certificado');
    }

    if (mode === 'certificate') {
      return this.run(this.api.signPdf(this.signFile, {
        mode,
        cert: this.signCert!,
        password: this.signPassword,
        reason: this.signReason,
        location: this.signLocation,
        outputName: this.outName(),
      }));
    }

    // drawn / combined: exigen imagen + colocación sobre la vista previa.
    if (!this.hasPreview()) {
      return this.warn('No hay vista previa del PDF: no se puede colocar la firma dibujada');
    }
    const signature = this.signatureBlob();
    if (!signature) return this.warn('Dibuja tu firma o sube una imagen');
    if (!this.signPlacement) return this.warn('Coloca la firma sobre la página');
    const pages = this.resolveSignPages();
    if (pages === null) return;

    const stamp = this.buildStamp();
    if (stamp === null) return;  // sello activado pero vacío: ya avisó

    this.run(this.api.signPdf(this.signFile, {
      mode,
      signature: signature.blob,
      signatureFilename: signature.filename,
      placement: this.signPlacement,
      pages,
      ...(stamp ? { stamp } : {}),
      ...(mode === 'combined'
        ? {
            cert: this.signCert!,
            password: this.signPassword,
            reason: this.signReason,
            location: this.signLocation,
          }
        : {}),
      outputName: this.outName(),
    }));
  }

  // --- Flujo genérico: subir → poll → resultado ---
  private run(request: Observable<ApiResponse<JobResponse>>): void {
    this.isProcessing.set(true);
    this.currentJob.set(null);
    request.subscribe({
      next: (response) => {
        if (response.success && response.data) {
          this.currentJob.set(response.data);
          this.pollJobStatus(response.data.jobId);
        } else {
          this.isProcessing.set(false);
          this.warn(response.error?.message || 'Error al iniciar la operación');
        }
      },
      error: (err) => {
        this.isProcessing.set(false);
        this.warn(err?.error?.error?.message || 'Error al subir el archivo');
      },
    });
  }

  private pollJobStatus(jobId: string): void {
    interval(2000).pipe(
      switchMap(() => this.api.getJobStatus(jobId)),
      takeWhile((r) => {
        const s = r.data?.status;
        return s === 'pending' || s === 'processing';
      }, true),
    ).subscribe({
      next: (r) => {
        if (r.data) {
          this.currentJob.set(r.data);
          if (r.data.status === 'completed' || r.data.status === 'failed') {
            this.isProcessing.set(false);
          }
        }
      },
      error: () => {
        this.isProcessing.set(false);
        this.warn('Error al obtener el estado');
      },
    });
  }

  download(): void {
    const job = this.currentJob();
    if (!job) return;
    this.api.downloadFile(job.jobId).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = job.outputFilename || 'resultado.pdf';
        a.click();
        window.URL.revokeObjectURL(url);
      },
      error: () => this.warn('Error al descargar el archivo'),
    });
  }

  formatSize(bytes: number): string {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private warn(message: string): void {
    this.snackBar.open(message, 'Cerrar', { duration: 3000 });
  }
}
