import { CommonModule } from '@angular/common';
import { Component, OnDestroy, ViewChild, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { PdfMarkupCanvasComponent } from '../../shared/pdf-markup/pdf-markup-canvas.component';
import { MarkupPropsComponent } from '../../shared/pdf-markup/markup-props.component';
import {
  CHECK_COLOR, CanvasMode, ElementType, HIGHLIGHT_COLOR, MarkKind, MarkupElement, STAMP_PRESETS,
  STROKE_COLOR, clamp, createElement, imageAspect,
} from '../../shared/pdf-markup/markup-element';
import { PagesPanelComponent } from './pages-panel.component';
import { AppliedStep, WorkspaceService } from './workspace.service';

/** Grupos de la cinta: qué está haciendo el usuario con el documento. */
type RibbonGroup = 'pages' | 'markup' | 'export';

/** Una exportación disponible desde el Estudio. */
interface ExportAction {
  id: string;
  label: string;
  path: string;
  /** Extensión del archivo que produce (para nombrar la descarga). */
  extension: string;
  /**
   * ¿La salida sigue siendo un PDF editable? Si lo es, pasa a ser el documento
   * de trabajo; si no (ZIP, .docx, PDF cifrado), se queda como un resultado
   * aparte que se descarga y el documento abierto no cambia.
   */
  chainable: boolean;
  description: string;
}

const EXPORTS: ExportAction[] = [
  {
    id: 'compress', label: 'Comprimir', path: '/compress', extension: 'pdf', chainable: true,
    description: 'Reduce el peso del documento y sigue trabajando con el resultado.',
  },
  {
    id: 'translate', label: 'Traducir', path: '/pdf/translate', extension: 'pdf', chainable: true,
    description: 'Traduce el texto manteniendo el diseño. Puede tardar varios minutos.',
  },
  {
    id: 'protect', label: 'Proteger con contraseña', path: '/pdf/protect', extension: 'pdf', chainable: false,
    description: 'Genera una copia cifrada. El documento abierto sigue sin contraseña.',
  },
  {
    id: 'split', label: 'Dividir en varios archivos', path: '/pdf/split', extension: 'zip', chainable: false,
    description: 'Produce un ZIP con las páginas o los rangos indicados.',
  },
  {
    id: 'to-word', label: 'Exportar a Word', path: '/pdf/to-word', extension: 'docx', chainable: false,
    description: 'Convierte el documento en un .docx editable.',
  },
  {
    id: 'to-excel', label: 'Exportar a Excel', path: '/pdf/to-excel', extension: 'xlsx', chainable: false,
    description: 'Extrae las tablas del documento a un .xlsx.',
  },
];

const TRANSLATE_LANGS = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'Inglés' },
  { code: 'fr', label: 'Francés' },
  { code: 'pt', label: 'Portugués' },
  { code: 'it', label: 'Italiano' },
  { code: 'de', label: 'Alemán' },
];

/**
 * El Estudio: un solo espacio de trabajo donde el documento es el centro y las
 * operaciones son verbos que se ejercen sobre él.
 *
 * Reemplaza el ir y venir de "sube → espera → descarga → vuelve a subir": aquí
 * los cambios se ven al instante y solo hay UNA descarga, al final.
 */
@Component({
  selector: 'app-estudio',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink,
    PdfMarkupCanvasComponent, MarkupPropsComponent, PagesPanelComponent,
  ],
  providers: [WorkspaceService],
  templateUrl: './estudio.component.html',
  styleUrl: './estudio.component.scss',
})
export class EstudioComponent implements OnDestroy {
  readonly group = signal<RibbonGroup>('pages');
  readonly currentPage = signal(1);
  readonly selectedId = signal('');
  readonly mode = signal<CanvasMode>('select');

  /** Exportación con el diálogo de opciones abierto (null = ninguno). */
  readonly openExport = signal<ExportAction | null>(null);
  readonly exports = EXPORTS;
  readonly languages = TRANSLATE_LANGS;
  readonly stampPresets = STAMP_PRESETS;

  // Opciones de las exportaciones
  compressionLevel = 'medium';
  protectPassword = '';
  splitMode: 'individual' | 'ranges' = 'individual';
  splitRanges = '';
  targetLang = 'en';

  /** alto/ancho de la página mostrada; lo reporta el lienzo al renderizar. */
  private pageAspect = Math.SQRT2;

  @ViewChild(PdfMarkupCanvasComponent) private canvas?: PdfMarkupCanvasComponent;

  constructor(readonly ws: WorkspaceService) {}

  ngOnDestroy(): void {
    this.ws.destroy();
  }

  readonly selected = computed(() =>
    this.ws.elements().find((e) => e.id === this.selectedId()),
  );

  readonly elementsOnPage = computed(() =>
    this.ws.elements().filter((e) => e.page === this.currentPage()),
  );

  /**
   * Página del ARCHIVO que hay que renderizar para la posición visible actual.
   * Mientras un reordenamiento está pendiente, la posición 1 puede ser la página
   * 3 del archivo: el lienzo tiene que pedir la 3, no la 1.
   */
  readonly canvasPage = computed(() =>
    this.ws.pages()[this.currentPage() - 1]?.source ?? this.currentPage(),
  );

  /** Giro pendiente de la página visible (aún no aplicado en el archivo). */
  readonly pendingRotation = computed(() =>
    this.ws.pages()[this.currentPage() - 1]?.rotate ?? 0,
  );

  get polyDraftLength(): number {
    return this.canvas?.polyDraft.length ?? 0;
  }

  // --- abrir documento ---

  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await this.openFile(file);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) await this.openFile(file);
  }

  private async openFile(file: File): Promise<void> {
    await this.ws.open(file);
    this.currentPage.set(1);
    this.selectedId.set('');
    this.group.set('pages');
  }

  // --- navegación ---

  goToPage(page: number): void {
    if (page < 1 || page > this.ws.pages().length) return;
    this.currentPage.set(page);
    this.selectedId.set('');
  }

  onPageAspect(aspect: number): void {
    this.pageAspect = aspect;
  }

  setGroup(group: RibbonGroup): void {
    this.group.set(group);
    this.openExport.set(null);
    if (group !== 'markup') this.mode.set('select');
  }

  // --- páginas ---

  async onReorder(move: { from: number; to: number }): Promise<void> {
    await this.ws.movePage(move.from, move.to);
  }

  async onRotatePage(index: number): Promise<void> {
    await this.ws.rotatePage(index, 90);
  }

  async onRemovePage(index: number): Promise<void> {
    await this.ws.deletePage(index);
    const total = this.ws.pages().length;
    if (this.currentPage() > total) this.currentPage.set(Math.max(1, total));
  }

  async rotateCurrent(): Promise<void> {
    await this.ws.rotatePage(this.currentPage() - 1, 90);
  }

  async removeCurrent(): Promise<void> {
    await this.onRemovePage(this.currentPage() - 1);
  }

  // --- marcado ---

  addText(): void { void this.add({ type: 'text', text: 'Texto', width: 0.3, height: 0.05 }); }
  addWhiteout(): void { void this.add({ type: 'whiteout', text: '', width: 0.25, height: 0.03 }); }
  addHighlight(): void { void this.add({ type: 'highlight', width: 0.3, height: 0.04, color: HIGHLIGHT_COLOR }); }
  addUnderline(): void { void this.add({ type: 'underline', width: 0.3, height: 0.02, color: STROKE_COLOR }); }
  addStrikeout(): void { void this.add({ type: 'strikeout', width: 0.3, height: 0.03, color: STROKE_COLOR }); }
  addLine(): void { void this.add({ type: 'line', width: 0.25, height: 0.12, color: STROKE_COLOR }); }
  addArrow(): void { void this.add({ type: 'arrow', width: 0.25, height: 0.12, color: STROKE_COLOR }); }
  addRect(): void { void this.add({ type: 'rect', width: 0.3, height: 0.12, color: STROKE_COLOR }); }
  addEllipse(): void { void this.add({ type: 'ellipse', width: 0.22, height: 0.08, color: STROKE_COLOR }); }
  addCloud(): void { void this.add({ type: 'cloud', width: 0.3, height: 0.15, color: STROKE_COLOR }); }

  addMark(kind: MarkKind): void {
    // Caja visualmente cuadrada: la fracción de alto se compensa con el aspecto.
    const width = 0.05;
    void this.add({
      type: 'mark', mark: kind, width,
      height: clamp(width / this.pageAspect, 0.02, 0.5),
      color: kind === 'check' ? CHECK_COLOR : STROKE_COLOR,
      strokeWidth: 3,
    });
  }

  addCallout(): void {
    const width = 0.28;
    const height = 0.06;
    const left = clamp(0.5 - width / 2, 0, 1 - width);
    void this.add({
      type: 'callout', text: 'Escribe aquí', width, height,
      color: STROKE_COLOR,
      tipX: clamp(left - 0.08, 0, 1),
      tipY: clamp(0.35 + height + 0.12, 0, 1),
    });
  }

  addStamp(preset: string): void {
    void this.add({
      type: 'stamp', text: preset, width: 0.26, height: 0.055,
      color: STROKE_COLOR, strokeWidth: 2.5, showDatetime: false,
    });
  }

  async onImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    const aspect = await imageAspect(url).catch(() => 0.6);
    const width = 0.25;
    await this.add({
      type: 'image', width, height: clamp(width * aspect / this.pageAspect, 0.03, 0.9),
      imageFile: file, imageUrl: url, imageAspect: aspect,
    });
  }

  /**
   * Añade un elemento. Puede materializar cambios de páginas pendientes antes
   * (ver `WorkspaceService.ensureKind`), por eso es asíncrono y relee la página.
   */
  private async add(partial: Partial<MarkupElement> & { type: ElementType }): Promise<void> {
    const el = createElement(this.currentPage(), partial);
    const added = await this.ws.addElement(el);
    if (added) this.selectedId.set(el.id);
  }

  onElementsChange(elements: MarkupElement[]): void {
    this.ws.setElements(elements);
  }

  removeElement(el: MarkupElement): void {
    this.ws.removeElement(el);
    if (this.selectedId() === el.id) this.selectedId.set('');
  }

  toggleMode(mode: CanvasMode): void {
    this.mode.set(this.mode() === mode ? 'select' : mode);
    if (this.mode() !== 'select') this.selectedId.set('');
  }

  finishPolygon(): void {
    this.canvas?.finishPolygon();
  }

  onPolygonFinished(): void {
    this.mode.set('select');
  }

  // --- exportaciones ---

  toggleExport(action: ExportAction): void {
    this.openExport.set(this.openExport()?.id === action.id ? null : action);
  }

  /** Campos propios de cada exportación (los demás van con sus defaults). */
  private exportFields(action: ExportAction): Record<string, string> | null {
    switch (action.id) {
      case 'compress':
        return { compressionLevel: this.compressionLevel };
      case 'protect':
        if (!this.protectPassword.trim()) return null;
        return { password: this.protectPassword };
      case 'split':
        return this.splitMode === 'ranges'
          ? { mode: 'ranges', ranges: this.splitRanges }
          : { mode: 'individual' };
      case 'translate':
        return { targetLang: this.targetLang };
      default:
        return {};
    }
  }

  async runExport(action: ExportAction): Promise<void> {
    const fields = this.exportFields(action);
    if (!fields) return;
    const jobId = await this.ws.runExport(action.path, fields, action.label, {
      chainable: action.chainable,
    });
    if (!jobId) return;
    this.openExport.set(null);
    this.protectPassword = '';
    if (!action.chainable) {
      // Resultado que no es el documento de trabajo: se descarga en el momento.
      const step = this.ws.appliedSteps().find((s) => s.jobId === jobId);
      if (step) await this.ws.downloadStep(step, action.extension);
    } else {
      this.currentPage.set(1);
    }
  }

  /** ¿La exportación abierta tiene todo lo que necesita para lanzarse? */
  canRunExport(action: ExportAction): boolean {
    return this.exportFields(action) !== null && !this.ws.busy();
  }

  // --- salida ---

  async applyPending(): Promise<void> {
    await this.ws.flush();
    this.currentPage.set(1);
    this.selectedId.set('');
  }

  async download(): Promise<void> {
    await this.ws.downloadResult();
    this.currentPage.set(1);
  }

  async undoStep(): Promise<void> {
    await this.ws.undoLastStep();
    this.currentPage.set(1);
    this.selectedId.set('');
  }

  stepLabel(step: AppliedStep): string {
    return step.label;
  }
}
