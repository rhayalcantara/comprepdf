import { Injectable, computed, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  ApiResponse, ApiService, JobResponse, OrganizedPage, StudioInput, StudioSession,
} from '../../core/services/api.service';
import { PdfDocHandle, PdfPreviewService } from '../../shared/pdf-preview/pdf-preview.service';
import { MarkupElement, elementsToEdits } from '../../shared/pdf-markup/markup-element';
import { newId } from '../../shared/uuid';

/**
 * Una página del documento tal como se ve AHORA en el panel de páginas.
 * `source` es su posición (1-based) en el archivo actual del servidor; `rotate`
 * el giro que el usuario le ha dado y que todavía no se ha aplicado.
 */
export interface PageItem {
  source: number;
  rotate: number;
}

/** Un paso ya materializado en el servidor (un job de la cadena). */
export interface AppliedStep {
  jobId: string;
  label: string;
  /** Job del que salió: permite deshacer volviendo atrás en la cadena. */
  parentJobId: string | null;
}

/** Qué tipo de cambio está pendiente. Nunca hay dos tipos a la vez (ver §flush). */
export type PendingKind = 'none' | 'pages' | 'markup';

const POLL_MS = 1200;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Estado del documento abierto en el Estudio y de su cadena de operaciones.
 *
 * ## El modelo, en una frase
 * Los cambios se ven al instante en pantalla y solo se mandan al servidor en los
 * puntos de *flush*; varios cambios del mismo tipo se funden en UN job.
 *
 * ## La invariante que lo hace correcto
 * Nunca hay cambios de dos tipos pendientes a la vez. Reordenar páginas con
 * marcado pendiente materializa primero el marcado (`ensureKind`). Sin esta
 * regla, un resaltado hecho antes de mover una página acabaría en la página
 * equivocada: `MarkupElement.page` es la posición VISIBLE, y mientras hay
 * marcado pendiente la lista de páginas es la identidad, así que visible ==
 * posición real en el archivo.
 */
@Injectable()
export class WorkspaceService {
  // --- documento abierto ---
  readonly fileName = signal('');
  readonly doc = signal<PdfDocHandle | null>(null);
  readonly pageCount = computed(() => this.doc()?.pageCount ?? 0);

  /** Páginas en el orden en que se ven, con su rotación pendiente. */
  readonly pages = signal<PageItem[]>([]);
  /** Marcado pendiente sobre la página visible. */
  readonly elements = signal<MarkupElement[]>([]);
  readonly pendingKind = signal<PendingKind>('none');

  /** Pasos ya aplicados en el servidor (la cadena de jobs de la sesión). */
  readonly appliedSteps = signal<AppliedStep[]>([]);

  readonly busy = signal(false);
  readonly statusMessage = signal('');
  readonly errorMessage = signal('');
  /** Nombre elegido para el archivo final (sin extensión). */
  outputName = '';

  // newId (no crypto.randomUUID): QA se sirve por HTTP y ahí randomUUID no existe.
  private sessionId = newId();
  /** Archivo que subió el usuario; es la entrada del PRIMER job de la cadena. */
  private originalFile: File | null = null;
  /** Bytes actuales que se están mostrando (original o salida del último job). */
  private currentFile: File | null = null;
  /** Último job de la cadena; null mientras no se haya aplicado nada. */
  private currentJobId: string | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly pdf: PdfPreviewService,
  ) {}

  // --- lecturas derivadas para la vista ---

  readonly hasDocument = computed(() => this.doc() !== null);

  /** ¿Se ha tocado el orden, la rotación o se ha borrado alguna página? */
  readonly pagesDirty = computed(() => {
    const pages = this.pages();
    if (pages.length !== this.pageCount()) return true;
    return pages.some((p, i) => p.source !== i + 1 || p.rotate !== 0);
  });

  readonly markupDirty = computed(() => this.elements().length > 0);
  readonly hasPending = computed(() => this.pagesDirty() || this.markupDirty());

  /**
   * Cambios pendientes, en lenguaje del usuario. Es lo que se lee en el panel
   * derecho: la respuesta a "¿qué le he hecho a este documento?".
   */
  readonly pendingSummary = computed<string[]>(() => {
    const out: string[] = [];
    const pages = this.pages();
    const deleted = this.pageCount() - pages.length;
    if (deleted > 0) out.push(`${deleted} página(s) eliminada(s)`);
    const rotated = pages.filter((p) => p.rotate !== 0).length;
    if (rotated > 0) out.push(`${rotated} página(s) girada(s)`);
    const reordered = pages.some((p, i) => p.source !== i + 1);
    if (reordered) out.push('Páginas reordenadas');
    const elements = this.elements();
    if (elements.length) out.push(`${elements.length} marca(s) sobre el documento`);
    return out;
  });

  /** ¿Hay algo que descargar? (o cambios pendientes, o pasos ya aplicados) */
  readonly canDownload = computed(() => this.hasDocument() && !this.busy());

  // --- abrir ---

  async open(file: File): Promise<void> {
    this.errorMessage.set('');
    if (file.type !== 'application/pdf') {
      this.errorMessage.set('El archivo debe ser un PDF.');
      return;
    }
    this.busy.set(true);
    this.statusMessage.set('Abriendo documento…');
    try {
      const handle = await this.pdf.open(file);
      void this.doc()?.destroy();
      // Documento nuevo = sesión nueva: la cadena anterior no le pertenece.
      this.sessionId = newId();
      this.originalFile = file;
      this.currentFile = file;
      this.currentJobId = null;
      this.appliedSteps.set([]);
      this.fileName.set(file.name);
      this.outputName = file.name.replace(/\.pdf$/i, '');
      this.doc.set(handle);
      this.resetPending(handle.pageCount);
      this.statusMessage.set('');
    } catch (e) {
      this.errorMessage.set(
        e === 'password'
          ? 'El PDF está protegido con contraseña. Quítala con "Desbloquear" y vuelve a abrirlo.'
          : 'No se pudo abrir el PDF.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** Vuelve la lista de páginas a la identidad y limpia el marcado. */
  private resetPending(pageCount: number): void {
    this.pages.set(Array.from({ length: pageCount }, (_, i) => ({ source: i + 1, rotate: 0 })));
    this.revokeImages();
    this.elements.set([]);
    this.pendingKind.set('none');
  }

  // --- edición de páginas (instantánea, sin servidor) ---

  /**
   * Declara qué tipo de cambio se va a hacer. Si había pendiente uno de OTRO
   * tipo, lo materializa primero: es la invariante que mantiene el marcado
   * anclado a la geometría sobre la que se colocó.
   */
  async ensureKind(kind: Exclude<PendingKind, 'none'>): Promise<boolean> {
    const current = this.pendingKind();
    if (current !== 'none' && current !== kind) {
      const ok = await this.flush();
      if (!ok) return false;
    }
    this.pendingKind.set(kind);
    return true;
  }

  async movePage(from: number, to: number): Promise<void> {
    if (from === to || !(await this.ensureKind('pages'))) return;
    const pages = [...this.pages()];
    if (from < 0 || from >= pages.length || to < 0 || to >= pages.length) return;
    const [moved] = pages.splice(from, 1);
    pages.splice(to, 0, moved);
    this.pages.set(pages);
  }

  async rotatePage(index: number, delta: number): Promise<void> {
    if (!(await this.ensureKind('pages'))) return;
    const pages = [...this.pages()];
    if (!pages[index]) return;
    pages[index] = { ...pages[index], rotate: (((pages[index].rotate + delta) % 360) + 360) % 360 };
    this.pages.set(pages);
  }

  async deletePage(index: number): Promise<void> {
    if (this.pages().length <= 1) {
      this.errorMessage.set('Un PDF debe conservar al menos una página.');
      return;
    }
    if (!(await this.ensureKind('pages'))) return;
    this.pages.set(this.pages().filter((_, i) => i !== index));
  }

  // --- marcado (instantáneo, sin servidor) ---

  async addElement(el: MarkupElement): Promise<boolean> {
    if (!(await this.ensureKind('markup'))) return false;
    this.elements.set([...this.elements(), el]);
    return true;
  }

  setElements(elements: MarkupElement[]): void {
    this.elements.set([...elements]);
  }

  removeElement(el: MarkupElement): void {
    if (el.imageUrl) URL.revokeObjectURL(el.imageUrl);
    const left = this.elements().filter((e) => e.id !== el.id);
    this.elements.set(left);
    if (!left.length && this.pendingKind() === 'markup') this.pendingKind.set('none');
  }

  // --- deshacer ---

  /** Descarta los cambios pendientes (los que aún no se mandaron al servidor). */
  discardPending(): void {
    this.resetPending(this.pageCount());
    // El error que hubiera era de lo que se acaba de descartar: dejarlo en
    // pantalla lo haría parecer un problema del documento actual.
    this.errorMessage.set('');
  }

  /**
   * Deshace el último paso YA aplicado volviendo a su job padre. El intermedio
   * sigue vivo en el servidor (la purga respeta un TTL holgado justo para esto).
   */
  async undoLastStep(): Promise<void> {
    const steps = this.appliedSteps();
    if (!steps.length || this.busy()) return;
    const last = steps[steps.length - 1];
    this.busy.set(true);
    this.statusMessage.set('Deshaciendo…');
    try {
      if (last.parentJobId) {
        await this.loadFromJob(last.parentJobId);
        this.currentJobId = last.parentJobId;
      } else {
        // El primer paso de la cadena: se vuelve al archivo que subió el usuario.
        await this.loadFile(this.originalFile!);
        this.currentJobId = null;
      }
      this.appliedSteps.set(steps.slice(0, -1));
      this.statusMessage.set('');
    } catch {
      this.errorMessage.set('No se pudo deshacer el último paso.');
    } finally {
      this.busy.set(false);
    }
  }

  // --- materialización (el único momento en que se habla con el servidor) ---

  /**
   * Manda al servidor lo que haya pendiente y recarga el documento resultante.
   * Devuelve false si algo falló (el llamador aborta lo que iba a hacer).
   */
  async flush(): Promise<boolean> {
    const kind = this.pendingKind();
    if (kind === 'none' || !this.hasPending()) {
      this.pendingKind.set('none');
      return true;
    }
    if (this.busy()) return false;

    this.busy.set(true);
    this.errorMessage.set('');
    try {
      if (kind === 'pages') {
        this.statusMessage.set('Aplicando cambios de páginas…');
        const pages: OrganizedPage[] = this.pages().map((p) => ({ source: p.source, rotate: p.rotate }));
        await this.runStep(
          this.api.studioOrganize(this.input(), pages, this.session()),
          this.pagesLabel(),
        );
      } else {
        this.statusMessage.set('Aplicando marcado…');
        const { edits, images } = elementsToEdits(this.elements());
        await this.runStep(
          this.api.studioEdit(this.input(), edits, images, this.session()),
          `${edits.length} marca(s)`,
        );
      }
      this.statusMessage.set('');
      return true;
    } catch (e) {
      // Limpiar el estado: dejar "Aplicando cambios…" colgado tras un fallo hace
      // creer que la operación sigue en marcha.
      this.statusMessage.set('');
      this.errorMessage.set(this.messageOf(e, 'No se pudieron aplicar los cambios.'));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Ejecuta una operación de EXPORTACIÓN (comprimir, proteger, firmar…): primero
   * materializa lo pendiente para que la exportación salga del documento tal como
   * se ve, y devuelve el job del resultado SIN incorporarlo al documento de
   * trabajo cuando no es un PDF (un ZIP o un .docx no se siguen editando).
   */
  async runExport(
    path: string,
    fields: Record<string, string>,
    label: string,
    opts: { chainable: boolean; files?: { field: string; file: Blob; name?: string }[] },
  ): Promise<string | null> {
    if (!(await this.flush())) return null;
    if (this.busy()) return null;
    this.busy.set(true);
    this.errorMessage.set('');
    this.statusMessage.set(`${label}…`);
    try {
      const jobId = await this.runJob(
        this.api.studioOperation(path, this.input(), this.session(), fields, opts.files ?? []),
      );
      if (opts.chainable) {
        await this.adoptJob(jobId, label);
      } else {
        // Salida no editable: se registra el paso para poder descargarlo, pero el
        // documento de trabajo se queda como estaba.
        this.appliedSteps.set([
          ...this.appliedSteps(),
          { jobId, label, parentJobId: this.currentJobId },
        ]);
      }
      this.statusMessage.set('');
      return jobId;
    } catch (e) {
      this.statusMessage.set('');
      this.errorMessage.set(this.messageOf(e, `No se pudo completar: ${label}.`));
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  /** Materializa lo pendiente y descarga el resultado. Una sola vez, al final. */
  async downloadResult(): Promise<void> {
    if (!(await this.flush())) return;
    const jobId = this.currentJobId;
    this.busy.set(true);
    try {
      if (!jobId) {
        // Nada que aplicar: se devuelve el archivo tal cual lo subió el usuario.
        this.saveBlob(this.originalFile!, this.downloadName('pdf'));
      } else {
        const blob = await firstValueFrom(this.api.downloadFile(jobId));
        this.saveBlob(blob, this.downloadName('pdf'));
      }
      this.statusMessage.set('Documento descargado.');
    } catch {
      this.errorMessage.set('No se pudo descargar el documento.');
    } finally {
      this.busy.set(false);
    }
  }

  /** Descarga un paso concreto (p. ej. el ZIP de una división). */
  async downloadStep(step: AppliedStep, extension: string): Promise<void> {
    this.busy.set(true);
    try {
      const blob = await firstValueFrom(this.api.downloadFile(step.jobId));
      this.saveBlob(blob, this.downloadName(extension));
    } catch {
      this.errorMessage.set('No se pudo descargar el resultado.');
    } finally {
      this.busy.set(false);
    }
  }

  // --- plomería ---

  private session(): StudioSession {
    return { sessionId: this.sessionId, outputName: this.outputName.trim() || undefined };
  }

  /** La entrada del siguiente job: la salida del anterior, o el archivo subido. */
  private input(): StudioInput {
    return this.currentJobId
      ? { sourceJobId: this.currentJobId }
      : { file: this.originalFile! };
  }

  /** Lanza el job, espera a que termine y adopta su salida como documento. */
  private async runStep(request: ReturnType<ApiService['studioOperation']>, label: string): Promise<void> {
    const jobId = await this.runJob(request);
    await this.adoptJob(jobId, label);
  }

  /** La salida del job pasa a ser el documento de trabajo. */
  private async adoptJob(jobId: string, label: string): Promise<void> {
    const parentJobId = this.currentJobId;
    await this.loadFromJob(jobId);
    this.currentJobId = jobId;
    this.appliedSteps.set([...this.appliedSteps(), { jobId, label, parentJobId }]);
  }

  /** Descarga el resultado de un job y lo abre como documento visible. */
  private async loadFromJob(jobId: string): Promise<void> {
    const blob = await firstValueFrom(this.api.downloadFile(jobId));
    await this.loadFile(new File([blob], this.fileName() || 'documento.pdf', { type: 'application/pdf' }));
  }

  private async loadFile(file: File): Promise<void> {
    const handle = await this.pdf.open(file);
    void this.doc()?.destroy();
    this.currentFile = file;
    this.doc.set(handle);
    this.resetPending(handle.pageCount);
  }

  /** POST + polling hasta que el job termina. Devuelve su id. */
  private async runJob(request: ReturnType<ApiService['studioOperation']>): Promise<string> {
    const res = await firstValueFrom(request);
    const jobId = res.data?.jobId;
    if (!res.success || !jobId) {
      throw new Error(res.error?.message ?? 'El servidor rechazó la operación.');
    }
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const status: ApiResponse<JobResponse> = await firstValueFrom(this.api.getJobStatus(jobId));
      const state = status.data?.status;
      if (state === 'completed') return jobId;
      if (state === 'failed') {
        throw new Error(status.data?.errorMessage ?? 'La operación falló en el servidor.');
      }
      if (Date.now() > deadline) {
        throw new Error('La operación está tardando demasiado; revisa "Mis trabajos".');
      }
    }
  }

  private pagesLabel(): string {
    return this.pendingSummary().join(' · ') || 'Cambios de páginas';
  }

  private downloadName(extension: string): string {
    const base = this.outputName.trim() || this.fileName().replace(/\.pdf$/i, '') || 'documento';
    return `${base}.${extension}`;
  }

  private saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Mensaje para el usuario. Angular envuelve los fallos de red en un
   * `HttpErrorResponse` cuyo `.message` es un volcado técnico ("Http failure
   * response for …: 0 Unknown Error") que no dice nada a quien lo lee: `status 0`
   * significa que la petición no llegó a salir, así que se traduce.
   */
  private messageOf(error: unknown, fallback: string): string {
    const http = error as { status?: number; error?: { error?: { message?: string } } };
    const fromApi = http?.error?.error?.message;
    if (fromApi) return fromApi;
    if (http?.status === 0) {
      return 'No se pudo contactar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
    }
    if (typeof http?.status === 'number' && http.status >= 500) {
      return 'El servidor tuvo un problema al procesar el documento. Inténtalo de nuevo.';
    }
    const message = (error as Error)?.message;
    // Los Error propios (los que lanza runJob) sí traen texto útil; los de
    // Angular empiezan por "Http failure" y no deben enseñarse tal cual.
    return message && !message.startsWith('Http failure') ? message : fallback;
  }

  private revokeImages(): void {
    for (const el of this.elements()) {
      if (el.imageUrl) URL.revokeObjectURL(el.imageUrl);
    }
  }

  destroy(): void {
    void this.doc()?.destroy();
    this.revokeImages();
  }
}
