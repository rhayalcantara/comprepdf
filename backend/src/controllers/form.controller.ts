import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AppDataSource } from '../config/database';
import { CompressionJob } from '../models/job.model';
import { PdfForm, PdfFormModel } from '../models/pdf-form.model';
import { logger } from '../utils/logger';
import { NotFoundError, UnauthorizedError } from '../utils/errors';
import { sanitizeOutputName } from '../utils/filename';
import { validateFormDefinition, FormDefinition } from '../utils/form-definition';

/**
 * Ownership de una definición de formulario (mismo criterio que los jobs):
 * admin ve todo; el usuario solo lo suyo; ajeno/huérfano → 404 (no 403).
 */
function assertFormVisible(form: { userId?: string | null }, req: Request): void {
  const user = req.user;
  if (!user) {
    throw new UnauthorizedError();
  }
  if (user.rol === 'admin') {
    return;
  }
  if (!form.userId || form.userId !== user.id) {
    throw new NotFoundError('Form not found');
  }
}

function questionCount(payload: Record<string, unknown>): number {
  const questions = (payload as { questions?: unknown }).questions;
  return Array.isArray(questions) ? questions.length : 0;
}

/**
 * Crea un job `form_generate` a partir de una definición ya validada. A
 * diferencia del resto de operaciones NO registra archivos originales: el worker
 * genera el PDF desde `operation_params.definition`. Devuelve el jobId.
 */
async function createFormJob(
  userId: string | null,
  definition: FormDefinition,
  outputName?: string,
): Promise<string> {
  const jobRepo = AppDataSource.getRepository(CompressionJob);
  const jobId = uuidv4();
  const job = jobRepo.create({
    id: jobId,
    userId,
    status: 'pending',
    operationType: 'form_generate',
    operationParams: {
      definition,
      ...(outputName ? { output_name: outputName } : {}),
    },
  });
  await jobRepo.save(job);
  logger.info(`Form job ${jobId} (form_generate) created`);
  return jobId;
}

/** GET /forms — lista las definiciones visibles (propias, o todas si admin). */
export const listForms = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = req.user!;
    const scope = user.rol === 'admin' ? null : user.id;
    const forms = await PdfFormModel.list(scope);
    res.json({
      success: true,
      data: forms.map((f) => ({
        id: f.id,
        name: f.name,
        questionCount: questionCount(f.payload),
        version: f.version,
        updatedAt: f.updatedAt,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/** GET /forms/:id — devuelve la definición completa (con ownership). */
export const getForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await PdfFormModel.findById(req.params.id);
    if (!form) {
      throw new NotFoundError('Form not found');
    }
    assertFormVisible(form, req);
    res.json({
      success: true,
      data: { ...form.payload, id: form.id, name: form.name, version: form.version },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /forms — crea una definición nueva. */
export const createForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const definition = validateFormDefinition(req.body);
    const id = uuidv4();
    const form = new PdfForm();
    form.id = id;
    form.userId = req.user?.id ?? null;
    form.name = definition.name;
    form.version = 1;
    form.payload = { ...definition, id, version: 1 };
    const saved = await PdfFormModel.save(form);
    res.status(201).json({
      success: true,
      data: { ...saved.payload, id: saved.id, name: saved.name, version: saved.version },
    });
  } catch (error) {
    next(error);
  }
};

/** PUT /forms/:id — actualiza una definición (nueva versión). */
export const updateForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const existing = await PdfFormModel.findById(req.params.id);
    if (!existing) {
      throw new NotFoundError('Form not found');
    }
    assertFormVisible(existing, req);

    const definition = validateFormDefinition(req.body);
    const version = existing.version + 1;
    existing.name = definition.name;
    existing.version = version;
    existing.payload = { ...definition, id: existing.id, version };
    const saved = await PdfFormModel.save(existing);
    res.json({
      success: true,
      data: { ...saved.payload, id: saved.id, name: saved.name, version: saved.version },
    });
  } catch (error) {
    next(error);
  }
};

/** DELETE /forms/:id — elimina una definición (con ownership). */
export const deleteForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await PdfFormModel.findById(req.params.id);
    if (!form) {
      throw new NotFoundError('Form not found');
    }
    assertFormVisible(form, req);
    await PdfFormModel.delete(form.id);
    res.json({ success: true, message: 'Form deleted successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /forms/:id/generate — genera el PDF rellenable de una definición guardada.
 * Crea un job `form_generate`; el PDF se descarga por /jobs/:jobId/download.
 */
export const generateForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await PdfFormModel.findById(req.params.id);
    if (!form) {
      throw new NotFoundError('Form not found');
    }
    assertFormVisible(form, req);

    const definition = validateFormDefinition(form.payload);
    const outputName = sanitizeOutputName(req.body?.outputName) ?? sanitizeOutputName(form.name);
    const jobId = await createFormJob(form.userId ?? req.user?.id ?? null, definition, outputName);

    res.status(201).json({
      success: true,
      data: { jobId, status: 'pending', operationType: 'form_generate' },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /forms/preview — genera un PDF de la definición enviada SIN persistirla
 * (vista previa del editor). Crea un job `form_generate` efímero.
 */
export const previewForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const definition = validateFormDefinition(req.body);
    const outputName = sanitizeOutputName(req.body?.outputName) ?? sanitizeOutputName(definition.name);
    const jobId = await createFormJob(req.user?.id ?? null, definition, outputName);

    res.status(201).json({
      success: true,
      data: { jobId, status: 'pending', operationType: 'form_generate' },
    });
  } catch (error) {
    next(error);
  }
};
