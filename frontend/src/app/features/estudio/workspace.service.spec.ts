import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { PdfPreviewService } from '../../shared/pdf-preview/pdf-preview.service';
import { createElement } from '../../shared/pdf-markup/markup-element';
import { WorkspaceService } from './workspace.service';

/**
 * Lo que se prueba aquí es el modelo de coalescencia del Estudio: cuándo se
 * habla con el servidor y cuándo no. Es la diferencia entre "una descarga por
 * sesión" y el ir y venir de archivos que originó el plan.
 */
describe('WorkspaceService', () => {
  let ws: WorkspaceService;
  let api: jasmine.SpyObj<ApiService>;
  let pdf: jasmine.SpyObj<PdfPreviewService>;
  /** Nº de páginas que dirá tener el documento que abre el pdf.js falso. */
  let pageCount: number;

  const PDF_FILE = () => new File(['%PDF-1.7'], 'informe.pdf', { type: 'application/pdf' });

  /** Handle mínimo de pdf.js: solo se usan pageCount, render y destroy. */
  const fakeDoc = () => ({
    pageCount,
    render: jasmine.createSpy('render').and.resolveTo(undefined),
    destroy: jasmine.createSpy('destroy').and.resolveTo(undefined),
  });

  /** Job que el backend acepta y que ya sale completado en el primer sondeo. */
  function stubJob(jobId: string): void {
    api.studioOperation.and.returnValue(of({ success: true, data: { jobId, status: 'pending' as const } }));
    api.studioOrganize.and.returnValue(of({ success: true, data: { jobId, status: 'pending' as const } }));
    api.studioEdit.and.returnValue(of({ success: true, data: { jobId, status: 'pending' as const } }));
    api.getJobStatus.and.returnValue(of({ success: true, data: { jobId, status: 'completed' as const } }));
    api.downloadFile.and.returnValue(of(new Blob(['%PDF-1.7'], { type: 'application/pdf' })));
  }

  beforeEach(async () => {
    pageCount = 4;
    api = jasmine.createSpyObj<ApiService>('ApiService', [
      'studioOperation', 'studioOrganize', 'studioEdit', 'getJobStatus', 'downloadFile',
    ]);
    pdf = jasmine.createSpyObj<PdfPreviewService>('PdfPreviewService', ['open']);
    pdf.open.and.callFake(() => Promise.resolve(fakeDoc() as never));
    stubJob('job-1');

    TestBed.configureTestingModule({
      providers: [
        WorkspaceService,
        { provide: ApiService, useValue: api },
        { provide: PdfPreviewService, useValue: pdf },
      ],
    });
    ws = TestBed.inject(WorkspaceService);
    await ws.open(PDF_FILE());
  });

  it('abre el documento con la lista de páginas en identidad', () => {
    expect(ws.hasDocument()).toBe(true);
    expect(ws.pages().length).toBe(4);
    expect(ws.pages().map((p) => p.source)).toEqual([1, 2, 3, 4]);
    expect(ws.pagesDirty()).toBe(false);
    expect(ws.hasPending()).toBe(false);
  });

  it('rechaza lo que no es PDF sin tocar el documento', async () => {
    await ws.open(new File(['x'], 'hoja.xlsx', { type: 'application/vnd.ms-excel' }));
    expect(ws.errorMessage()).toContain('debe ser un PDF');
  });

  // --- Nada toca el servidor hasta el flush ---

  describe('edición diferida', () => {
    it('reordenar, girar y borrar no llaman al servidor', async () => {
      await ws.movePage(0, 2);
      await ws.rotatePage(1, 90);
      await ws.deletePage(3);

      expect(api.studioOrganize).not.toHaveBeenCalled();
      expect(ws.pagesDirty()).toBe(true);
      expect(ws.pages().length).toBe(3);
    });

    it('varios cambios de páginas se funden en UN solo job', async () => {
      await ws.movePage(0, 2);
      await ws.rotatePage(1, 90);
      await ws.deletePage(3);

      await ws.flush();

      expect(api.studioOrganize).toHaveBeenCalledTimes(1);
      expect(ws.appliedSteps().length).toBe(1);
    });

    it('varias marcas se funden en UN solo job', async () => {
      await ws.addElement(createElement(1, { type: 'highlight' }));
      await ws.addElement(createElement(1, { type: 'stamp', text: 'PAGADO' }));
      await ws.addElement(createElement(2, { type: 'rect' }));

      expect(api.studioEdit).not.toHaveBeenCalled();

      await ws.flush();

      expect(api.studioEdit).toHaveBeenCalledTimes(1);
      const edits = api.studioEdit.calls.mostRecent().args[1];
      expect(edits.length).toBe(3);
    });

    it('el flush sin nada pendiente no crea jobs', async () => {
      await ws.flush();
      expect(api.studioOrganize).not.toHaveBeenCalled();
      expect(api.studioEdit).not.toHaveBeenCalled();
    });
  });

  // --- La invariante que mantiene el marcado en su sitio ---

  describe('invariante: nunca hay dos tipos de cambio pendientes', () => {
    it('mover una página con marcado pendiente materializa el marcado primero', async () => {
      await ws.addElement(createElement(1, { type: 'highlight' }));
      expect(ws.pendingKind()).toBe('markup');

      await ws.movePage(0, 2);

      expect(api.studioEdit).toHaveBeenCalledTimes(1);
      expect(ws.pendingKind()).toBe('pages');
      // Tras aplicar el marcado el documento se recargó: el marcado ya no cuelga.
      expect(ws.elements().length).toBe(0);
    });

    it('marcar con páginas pendientes materializa las páginas primero', async () => {
      await ws.rotatePage(0, 90);
      expect(ws.pendingKind()).toBe('pages');

      await ws.addElement(createElement(1, { type: 'rect' }));

      expect(api.studioOrganize).toHaveBeenCalledTimes(1);
      expect(ws.pendingKind()).toBe('markup');
      expect(ws.pages().map((p) => p.rotate)).toEqual([0, 0, 0, 0]);
    });

    it('mientras hay marcado pendiente, la lista de páginas es la identidad', async () => {
      await ws.addElement(createElement(1, { type: 'highlight' }));
      // Es lo que hace que `MarkupElement.page` (posición visible) coincida con
      // la página real del archivo al mandar las ediciones.
      expect(ws.pagesDirty()).toBe(false);
    });

    it('si el flush intermedio falla, el cambio nuevo no se aplica', async () => {
      api.studioEdit.and.returnValue(of({ success: false, error: { message: 'boom' } }));
      await ws.addElement(createElement(1, { type: 'highlight' }));

      await ws.movePage(0, 2);

      expect(ws.errorMessage()).toContain('boom');
      expect(ws.pages().map((p) => p.source)).toEqual([1, 2, 3, 4]);
    });
  });

  // --- Cadena de jobs y deshacer ---

  describe('cadena de jobs', () => {
    it('el primer paso sube el archivo y el segundo encadena por sourceJobId', async () => {
      await ws.rotatePage(0, 90);
      await ws.flush();
      expect('file' in api.studioOrganize.calls.mostRecent().args[0]).toBe(true);

      stubJob('job-2');
      await ws.addElement(createElement(1, { type: 'rect' }));
      await ws.flush();

      const input = api.studioEdit.calls.mostRecent().args[0];
      expect(input).toEqual({ sourceJobId: 'job-1' });
    });

    it('todos los pasos comparten la misma sesión', async () => {
      await ws.rotatePage(0, 90);
      await ws.flush();
      const first = api.studioOrganize.calls.mostRecent().args[2].sessionId;

      stubJob('job-2');
      await ws.addElement(createElement(1, { type: 'rect' }));
      await ws.flush();
      const second = api.studioEdit.calls.mostRecent().args[3].sessionId;

      expect(first).toBeTruthy();
      expect(second).toBe(first);
    });

    it('abrir otro documento empieza una sesión nueva', async () => {
      await ws.rotatePage(0, 90);
      await ws.flush();
      const first = api.studioOrganize.calls.mostRecent().args[2].sessionId;

      await ws.open(PDF_FILE());
      await ws.rotatePage(0, 90);
      await ws.flush();
      const second = api.studioOrganize.calls.mostRecent().args[2].sessionId;

      expect(second).not.toBe(first);
      expect(ws.appliedSteps().length).toBe(1);
    });

    it('deshacer el último paso vuelve al archivo original cuando era el primero', async () => {
      await ws.rotatePage(0, 90);
      await ws.flush();
      expect(ws.appliedSteps().length).toBe(1);

      await ws.undoLastStep();

      expect(ws.appliedSteps().length).toBe(0);
      expect(ws.pagesDirty()).toBe(false);
    });

    it('deshacer con dos pasos vuelve al job anterior, no al original', async () => {
      await ws.rotatePage(0, 90);
      await ws.flush();
      stubJob('job-2');
      await ws.addElement(createElement(1, { type: 'rect' }));
      await ws.flush();
      expect(ws.appliedSteps().length).toBe(2);

      api.downloadFile.calls.reset();
      await ws.undoLastStep();

      expect(ws.appliedSteps().length).toBe(1);
      expect(api.downloadFile).toHaveBeenCalledWith('job-1');
    });
  });

  // --- Exportaciones ---

  describe('exportaciones', () => {
    it('materializa lo pendiente antes de exportar', async () => {
      await ws.rotatePage(0, 90);

      await ws.runExport('/compress', { compressionLevel: 'medium' }, 'Comprimir', { chainable: true });

      expect(api.studioOrganize).toHaveBeenCalledTimes(1);
      expect(api.studioOperation).toHaveBeenCalledTimes(1);
    });

    it('una salida encadenable pasa a ser el documento de trabajo', async () => {
      await ws.runExport('/compress', { compressionLevel: 'low' }, 'Comprimir', { chainable: true });

      expect(ws.appliedSteps().length).toBe(1);
      // Se recargó el documento con el resultado.
      expect(pdf.open).toHaveBeenCalledTimes(2);
    });

    it('una salida NO encadenable (ZIP, .docx) no cambia el documento abierto', async () => {
      pdf.open.calls.reset();

      await ws.runExport('/pdf/split', { mode: 'individual' }, 'Dividir', { chainable: false });

      expect(ws.appliedSteps().length).toBe(1);
      expect(pdf.open).not.toHaveBeenCalled();
    });
  });

  // --- Errores: lo que ve el usuario cuando algo falla ---

  describe('mensajes de error', () => {
    it('traduce el fallo de red en vez de volcar el texto de Angular', async () => {
      // Así llega un servidor caído: HttpErrorResponse con status 0 y un
      // `.message` del tipo "Http failure response for …: 0 Unknown Error".
      api.studioOrganize.and.returnValue(throwError(() => ({
        status: 0,
        message: 'Http failure response for http://localhost:3000/api/v1/pdf/organize: 0 Unknown Error',
      })));
      await ws.rotatePage(0, 90);

      await ws.flush();

      expect(ws.errorMessage()).toBe(
        'No se pudo contactar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
      );
      expect(ws.errorMessage()).not.toContain('Http failure');
    });

    it('no deja el estado "Aplicando…" colgado tras un fallo', async () => {
      api.studioOrganize.and.returnValue(throwError(() => ({ status: 0 })));
      await ws.rotatePage(0, 90);

      await ws.flush();

      expect(ws.statusMessage()).toBe('');
      expect(ws.busy()).toBe(false);
    });

    it('prefiere el mensaje del backend cuando lo hay', async () => {
      api.studioOrganize.and.returnValue(throwError(() => ({
        status: 400,
        error: { error: { message: 'pages must be a non-empty array' } },
      })));
      await ws.rotatePage(0, 90);

      await ws.flush();

      expect(ws.errorMessage()).toBe('pages must be a non-empty array');
    });

    it('descartar pendientes limpia el error de lo descartado', async () => {
      api.studioOrganize.and.returnValue(throwError(() => ({ status: 0 })));
      await ws.rotatePage(0, 90);
      await ws.flush();
      expect(ws.errorMessage()).toBeTruthy();

      ws.discardPending();

      expect(ws.errorMessage()).toBe('');
      expect(ws.hasPending()).toBe(false);
    });
  });

  // --- Resumen para el usuario ---

  describe('resumen de cambios pendientes', () => {
    it('describe eliminaciones, giros y reordenación', async () => {
      await ws.deletePage(3);
      await ws.rotatePage(0, 90);
      await ws.movePage(0, 2);

      const summary = ws.pendingSummary();
      expect(summary).toContain('1 página(s) eliminada(s)');
      expect(summary).toContain('1 página(s) girada(s)');
      expect(summary).toContain('Páginas reordenadas');
    });

    it('no deja borrar la última página', async () => {
      pageCount = 1;
      await ws.open(PDF_FILE());

      await ws.deletePage(0);

      expect(ws.pages().length).toBe(1);
      expect(ws.errorMessage()).toContain('al menos una página');
    });
  });
});
