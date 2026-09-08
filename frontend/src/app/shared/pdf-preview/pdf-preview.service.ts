import { Injectable, NgZone } from '@angular/core';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

export type PdfPreviewError = 'password' | 'invalid' | 'error';

export interface PdfDocHandle {
  readonly pageCount: number;
  /**
   * Renderiza la página (1-based) en el canvas, ajustada a maxWidth px CSS
   * (× devicePixelRatio, tope 2). Encolado con concurrencia limitada.
   */
  render(pageNumber: number, canvas: HTMLCanvasElement, maxWidth: number): Promise<void>;
  /** Cancela renders pendientes y libera el documento (worker + memoria). */
  destroy(): Promise<void>;
}

// pdfjs se importa dinámicamente: esbuild lo separa en un chunk propio que solo
// se descarga cuando el usuario sube un PDF. El worker es un asset estático
// (assets/pdfjs, ver angular.json) — QA no tiene internet, nada de CDNs.
// Si el navegador destino no soporta Promise.withResolvers (Chrome <119),
// cambiar ambos a 'pdfjs-dist/legacy/build/...'.
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  return (pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = 'assets/pdfjs/pdf.worker.min.mjs';
    return pdfjs;
  }));
}

const MAX_CONCURRENT_RENDERS = 2;

@Injectable({ providedIn: 'root' })
export class PdfPreviewService {
  constructor(private zone: NgZone) {}

  /** Rechaza con PdfPreviewError: 'password', 'invalid' o 'error'. */
  async open(file: File): Promise<PdfDocHandle> {
    const pdfjs = await loadPdfjs();
    const data = await file.arrayBuffer();
    try {
      const doc = await this.zone.runOutsideAngular(() =>
        pdfjs.getDocument({
          data,
          cMapUrl: 'assets/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: 'assets/pdfjs/standard_fonts/',
          isEvalSupported: false,
        }).promise,
      );
      return new DocHandle(doc, this.zone);
    } catch (e: unknown) {
      const name = (e as { name?: string })?.name;
      if (name === 'PasswordException') throw 'password' satisfies PdfPreviewError;
      if (name === 'InvalidPDFException') throw 'invalid' satisfies PdfPreviewError;
      throw 'error' satisfies PdfPreviewError;
    }
  }
}

interface RenderJob {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  maxWidth: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

class DocHandle implements PdfDocHandle {
  readonly pageCount: number;

  private queue: RenderJob[] = [];
  private active = 0;
  private activeTasks = new Set<RenderTask>();
  private destroyed = false;

  constructor(private doc: PDFDocumentProxy, private zone: NgZone) {
    this.pageCount = doc.numPages;
  }

  render(pageNumber: number, canvas: HTMLCanvasElement, maxWidth: number): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ pageNumber, canvas, maxWidth, resolve, reject });
      this.pump();
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue.forEach((job) => job.resolve());
    this.queue = [];
    this.activeTasks.forEach((task) => task.cancel());
    await this.doc.destroy().catch(() => undefined);
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_RENDERS && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      this.zone.runOutsideAngular(() =>
        this.renderJob(job).finally(() => {
          this.active--;
          this.pump();
        }),
      );
    }
  }

  private async renderJob(job: RenderJob): Promise<void> {
    if (this.destroyed) {
      job.resolve();
      return;
    }
    try {
      const page = await this.doc.getPage(job.pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (job.maxWidth * dpr) / base.width });
        job.canvas.width = Math.ceil(viewport.width);
        job.canvas.height = Math.ceil(viewport.height);
        const canvasContext = job.canvas.getContext('2d')!;
        const task = page.render({ canvasContext, viewport });
        this.activeTasks.add(task);
        try {
          await task.promise;
        } finally {
          this.activeTasks.delete(task);
        }
        job.resolve();
      } finally {
        page.cleanup();
      }
    } catch (e: unknown) {
      // Cancelaciones (destroy/cambio de archivo) no son errores del caller.
      if ((e as { name?: string })?.name === 'RenderingCancelledException' || this.destroyed) {
        job.resolve();
      } else {
        job.reject(e);
      }
    }
  }
}
