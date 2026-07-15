import { Request, Response, NextFunction } from 'express';

jest.mock('../../src/config/database');
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/models/pdf-form.model', () => ({
  PdfForm: class {
    id!: string;
    userId?: string | null;
    name!: string;
    version!: number;
    payload!: Record<string, unknown>;
  },
  PdfFormModel: {
    list: jest.fn(),
    findById: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  },
}));

import { AppDataSource } from '../../src/config/database';
import { PdfFormModel } from '../../src/models/pdf-form.model';
import { CompressionJob } from '../../src/models/job.model';
import { NotFoundError, ValidationError } from '../../src/utils/errors';
import {
  listForms, getForm, createForm, updateForm, deleteForm, generateForm, previewForm,
} from '../../src/controllers/form.controller';

const model = PdfFormModel as jest.Mocked<typeof PdfFormModel>;

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Solicitud',
    description: '',
    page_size: 'letter',
    header: { title: 'Solicitud de servicio', subtitle: '' },
    footer: { text: '', show_page_numbers: true },
    questions: [
      { name: 'nombre', type: 'short_text', label: 'Nombre', help_text: '', required: true, options: [] },
    ],
    ...overrides,
  };
}

/** Fila de pdf_forms simulada tal cual la devuelve el modelo. */
function storedForm(userId: string | null, id = 'form-1') {
  return {
    id,
    userId,
    name: 'Solicitud',
    version: 3,
    payload: { ...validBody(), id, version: 3 },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

describe('form.controller', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let jobRepo: { create: jest.Mock; save: jest.Mock };

  const user = { id: 'u1', rol: 'user' } as Request['user'];
  const admin = { id: 'a1', rol: 'admin' } as Request['user'];

  const savedForm = () => model.save.mock.calls[0][0];
  const savedJob = () => jobRepo.save.mock.calls[0][0];

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    res = { json: jsonMock, status: statusMock };
    next = jest.fn();

    jobRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) =>
      entity === CompressionJob ? jobRepo : ({} as never),
    );
    model.save.mockImplementation(async (f: any) => f);
    model.list.mockResolvedValue([]);
    model.delete.mockResolvedValue(undefined as never);
  });

  afterEach(() => jest.clearAllMocks());

  function expectValidationError(): void {
    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(ValidationError);
  }
  function expectNotFound(): void {
    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(NotFoundError);
  }

  describe('listForms', () => {
    it('usuario normal lista solo lo suyo (scope = su id)', async () => {
      req = { user };
      await listForms(req as Request, res as Response, next);
      expect(model.list).toHaveBeenCalledWith('u1');
    });

    it('admin lista todo (scope = null)', async () => {
      req = { user: admin };
      await listForms(req as Request, res as Response, next);
      expect(model.list).toHaveBeenCalledWith(null);
    });
  });

  describe('createForm', () => {
    it('crea con version 1 y dueño = usuario', async () => {
      req = { user, body: validBody() };
      await createForm(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);
      const form = savedForm();
      expect(form.userId).toBe('u1');
      expect(form.version).toBe(1);
      expect(form.name).toBe('Solicitud');
      expect(form.payload.version).toBe(1);
    });

    it('body inválido responde 400 sin guardar', async () => {
      req = { user, body: validBody({ name: '' }) };
      await createForm(req as Request, res as Response, next);
      expectValidationError();
      expect(model.save).not.toHaveBeenCalled();
    });
  });

  describe('getForm', () => {
    it('inexistente → 404', async () => {
      model.findById.mockResolvedValue(null);
      req = { user, params: { id: 'x' } };
      await getForm(req as Request, res as Response, next);
      expectNotFound();
    });

    it('de otro usuario → 404 (ownership)', async () => {
      model.findById.mockResolvedValue(storedForm('otro'));
      req = { user, params: { id: 'form-1' } };
      await getForm(req as Request, res as Response, next);
      expectNotFound();
    });

    it('propio → devuelve la definición', async () => {
      model.findById.mockResolvedValue(storedForm('u1'));
      req = { user, params: { id: 'form-1' } };
      await getForm(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: expect.objectContaining({ id: 'form-1' }) }),
      );
    });

    it('admin ve el de cualquiera', async () => {
      model.findById.mockResolvedValue(storedForm('otro'));
      req = { user: admin, params: { id: 'form-1' } };
      await getForm(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('updateForm', () => {
    it('sube la versión y persiste la nueva definición', async () => {
      model.findById.mockResolvedValue(storedForm('u1'));
      req = { user, params: { id: 'form-1' }, body: validBody({ name: 'Actualizada' }) };
      await updateForm(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      const form = savedForm();
      expect(form.version).toBe(4); // 3 + 1
      expect(form.name).toBe('Actualizada');
      expect(form.payload.version).toBe(4);
    });

    it('de otro usuario → 404 y no guarda', async () => {
      model.findById.mockResolvedValue(storedForm('otro'));
      req = { user, params: { id: 'form-1' }, body: validBody() };
      await updateForm(req as Request, res as Response, next);
      expectNotFound();
      expect(model.save).not.toHaveBeenCalled();
    });
  });

  describe('deleteForm', () => {
    it('propio → elimina', async () => {
      model.findById.mockResolvedValue(storedForm('u1'));
      req = { user, params: { id: 'form-1' } };
      await deleteForm(req as Request, res as Response, next);
      expect(model.delete).toHaveBeenCalledWith('form-1');
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('ajeno → 404 y no elimina', async () => {
      model.findById.mockResolvedValue(storedForm('otro'));
      req = { user, params: { id: 'form-1' } };
      await deleteForm(req as Request, res as Response, next);
      expectNotFound();
      expect(model.delete).not.toHaveBeenCalled();
    });
  });

  describe('generateForm', () => {
    it('crea un job form_generate con la definición en params', async () => {
      model.findById.mockResolvedValue(storedForm('u1'));
      req = { user, params: { id: 'form-1' }, body: {} };
      await generateForm(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);
      const job = savedJob();
      expect(job.operationType).toBe('form_generate');
      expect(job.operationParams.definition).toEqual(expect.objectContaining({ name: 'Solicitud' }));
      expect(job.operationParams.output_name).toBe('Solicitud');
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ jobId: job.id }) }),
      );
    });

    it('de otro usuario → 404 y no crea job', async () => {
      model.findById.mockResolvedValue(storedForm('otro'));
      req = { user, params: { id: 'form-1' }, body: {} };
      await generateForm(req as Request, res as Response, next);
      expectNotFound();
      expect(jobRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('previewForm', () => {
    it('crea un job form_generate SIN persistir la definición', async () => {
      req = { user, body: validBody() };
      await previewForm(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);
      expect(model.save).not.toHaveBeenCalled();
      const job = savedJob();
      expect(job.operationType).toBe('form_generate');
      expect(job.userId).toBe('u1');
      expect(job.operationParams.definition).toEqual(expect.objectContaining({ name: 'Solicitud' }));
    });

    it('body inválido responde 400', async () => {
      req = { user, body: validBody({ questions: [{ name: 'p', type: 'radio', label: 'x', help_text: '', required: false, options: ['solo'] }] }) };
      await previewForm(req as Request, res as Response, next);
      expectValidationError();
      expect(jobRepo.save).not.toHaveBeenCalled();
    });
  });
});
