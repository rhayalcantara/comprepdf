import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { In } from 'typeorm';
import { AppDataSource } from '../config/database';
import { CompressionJob } from '../models/job.model';
import { File } from '../models/file.model';
import { config } from '../config/env';
import { NotFoundError, ValidationError } from '../utils/errors';
import { assertJobVisible } from '../utils/job-access';
import { logger } from '../utils/logger';

/**
 * Sesión de trabajo del Estudio adjuntada a la request. `parentJobId` solo
 * aparece cuando la entrada se tomó de un job anterior en vez de una subida.
 */
export interface WorkSession {
  sessionId?: string | null;
  parentJobId?: string | null;
}

/** UUID v4 tal como lo generan `uuidv4()` y `crypto.randomUUID()` del navegador. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Devuelve las columnas de sesión con las que crear el job. Se lee de la request
 * (no del body directamente) para que `resolveSourceJob` sea la ÚNICA pieza que
 * decide qué es una sesión válida y de qué job desciende.
 */
export function sessionColumns(req: Request): { sessionId: string | null; parentJobId: string | null } {
  return {
    sessionId: req.workSession?.sessionId ?? null,
    parentJobId: req.workSession?.parentJobId ?? null,
  };
}

/** Normaliza `sessionId` del body: ausente/inválido ⇒ null (job suelto). */
function parseSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : null;
}

/** ¿La request ya trae el PDF principal subido por el usuario? */
function hasUploadedMainFile(req: Request): boolean {
  if (req.file) return true;
  const files = req.files;
  if (!files) return false;
  if (Array.isArray(files)) return files.length > 0;
  return (files.file?.length ?? 0) > 0;
}

/**
 * Materializa la SALIDA de un job anterior como entrada de la operación actual.
 *
 * Es el corazón de la Fase 0 del Estudio: sin esto, encadenar dos operaciones
 * obliga al usuario a descargar el resultado y volver a subirlo — la queja que
 * originó el plan. Con esto, el cliente manda `{ sourceJobId }` y el backend
 * copia el archivo de salida a `uploads/` como si lo hubiera subido.
 *
 * Devuelve el archivo sintético con la misma forma que produce multer, para que
 * los controladores y `validatePdfFile` funcionen SIN cambios.
 */
async function materializeSourceOutput(
  req: Request,
  sourceJobId: string,
): Promise<Express.Multer.File> {
  const job = await AppDataSource.getRepository(CompressionJob).findOne({
    where: { id: sourceJobId },
  });
  if (!job) {
    throw new NotFoundError('Job not found');
  }
  // Misma regla que la descarga: un job ajeno u huérfano es indistinguible de
  // uno inexistente. Encadenar NO puede ser una puerta lateral al archivo.
  assertJobVisible(job, req);

  if (job.status !== 'completed') {
    throw new ValidationError(`Source job is not finished yet (status: ${job.status})`);
  }

  const file = await AppDataSource.getRepository(File).findOne({
    where: { jobId: sourceJobId, fileType: In(['compressed', 'output']) },
  });
  if (!file) {
    throw new NotFoundError('Output file not found');
  }

  // Solo se encadena sobre PDF. Las operaciones que producen otra cosa (split →
  // ZIP, pdf_to_word → .docx, pdf_to_excel → .xlsx) son hojas del árbol: su
  // salida se descarga, no se sigue editando.
  const isPdf = file.mimeType === 'application/pdf'
    || path.extname(file.originalFilename).toLowerCase() === '.pdf';
  if (!isPdf) {
    throw new ValidationError(
      `The result of the source job is not a PDF (${file.originalFilename}); it cannot be chained`,
    );
  }

  // Copia (no enlace ni reutilización): el job nuevo es dueño de SU entrada y la
  // purga de intermedios puede borrar la del job padre sin dejarlo cojo.
  const filename = `${uuidv4()}.pdf`;
  const destination = path.resolve(config.upload.uploadDir, filename);
  await fs.copyFile(file.filePath, destination);
  const { size } = await fs.stat(destination);

  logger.info(`Chained job input from ${sourceJobId} -> ${filename} (${size} bytes)`);

  return {
    fieldname: 'file',
    originalname: file.originalFilename,
    encoding: '7bit',
    mimetype: 'application/pdf',
    destination: path.resolve(config.upload.uploadDir),
    filename,
    path: destination,
    size,
    stream: undefined as never,
    buffer: undefined as never,
  };
}

/**
 * Permite que una operación tome su entrada de un job anterior (`sourceJobId`)
 * en lugar de un archivo subido, y anota la sesión de trabajo (`sessionId`).
 *
 * Se monta DESPUÉS de multer y ANTES de la validación: cuando termina, `req.file`
 * está puesto venga de donde venga, así que `validatePdfFile` y el controlador no
 * distinguen entre una subida y un encadenado.
 *
 * Si la request ya trae archivo subido, `sourceJobId` se ignora: lo que el
 * usuario acaba de subir manda siempre sobre lo que dice el cuerpo.
 */
export const resolveSourceJob = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const sessionId = parseSessionId(req.body?.sessionId);
    const rawSourceId = typeof req.body?.sourceJobId === 'string' ? req.body.sourceJobId.trim() : '';

    if (hasUploadedMainFile(req) || !rawSourceId) {
      req.workSession = { sessionId, parentJobId: null };
      next();
      return;
    }

    if (!UUID_PATTERN.test(rawSourceId)) {
      throw new ValidationError('sourceJobId must be a valid job id');
    }

    const file = await materializeSourceOutput(req, rawSourceId);
    req.file = file;
    // En las rutas con `.fields()` (sign, edit) el controlador busca el PDF en
    // `req.files.file`; se rellena también ahí cuando multer creó el objeto.
    if (req.files && !Array.isArray(req.files)) {
      req.files.file = [file];
    }

    req.workSession = { sessionId, parentJobId: rawSourceId };
    next();
  } catch (error) {
    next(error);
  }
};

// --- Merge: secuencia mixta de jobs previos y archivos subidos ---

/** Tope de piezas a unir; el mismo que `uploadMultiple.array('files', 50)`. */
const MAX_MERGE_SOURCES = 50;

/**
 * Una pieza de la secuencia de merge: la salida de un job anterior
 * (`{ jobId }`) o uno de los archivos subidos en esta petición
 * (`{ upload: <índice en files[]> }`).
 */
type MergeSource = { jobId: string } | { upload: number };

/** Parsea `sources` (array real o su forma JSON). Ausente ⇒ null. */
function parseMergeSources(raw: unknown): MergeSource[] | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new ValidationError('sources must be a JSON array');
    }
  }
  if (!Array.isArray(arr)) throw new ValidationError('sources must be an array');
  if (arr.length < 2) throw new ValidationError('Merge requires at least 2 sources');
  if (arr.length > MAX_MERGE_SOURCES) {
    throw new ValidationError(`Too many sources (max ${MAX_MERGE_SOURCES})`);
  }

  return arr.map((entry, i) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (typeof e.jobId === 'string') {
      const jobId = e.jobId.trim();
      if (!UUID_PATTERN.test(jobId)) {
        throw new ValidationError(`Source ${i + 1} has an invalid jobId`);
      }
      return { jobId };
    }
    const upload = typeof e.upload === 'number' ? e.upload : Number(e.upload);
    if (!Number.isInteger(upload) || upload < 0) {
      throw new ValidationError(`Source ${i + 1} must have a jobId or an upload index`);
    }
    return { upload };
  });
}

/**
 * Ordena las piezas del merge cuando el Estudio une el documento abierto con
 * archivos recién subidos ("insertar páginas desde otro archivo").
 *
 * Sin `sources` el comportamiento es el de siempre: se unen los archivos subidos
 * en su orden. Con `sources`, el cliente dicta la secuencia exacta mezclando
 * jobs previos y subidas — que es lo que hace falta para insertar un PDF EN MEDIO
 * del documento que ya se está editando.
 *
 * Deja `req.files` como el array ordenado que espera `validatePdfFiles`, así que
 * la validación de magic bytes y el controlador siguen sin enterarse.
 */
export const resolveMergeSources = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const uploaded = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  try {
    const sessionId = parseSessionId(req.body?.sessionId);
    const sources = parseMergeSources(req.body?.sources);

    if (!sources) {
      req.workSession = { sessionId, parentJobId: null };
      next();
      return;
    }

    const ordered: Express.Multer.File[] = [];
    const usedUploads = new Set<number>();
    for (const source of sources) {
      if ('upload' in source) {
        const file = uploaded[source.upload];
        if (!file) {
          throw new ValidationError(`Source references a missing upload (index ${source.upload})`);
        }
        usedUploads.add(source.upload);
        ordered.push(file);
      } else {
        ordered.push(await materializeSourceOutput(req, source.jobId));
      }
    }

    // Subidas que la secuencia no menciona: no se unen y nadie las va a
    // reclamar, así que no se quedan ocupando disco.
    await Promise.all(
      uploaded
        .filter((_, i) => !usedUploads.has(i))
        .map((f) => fs.unlink(f.path).catch(() => undefined)),
    );

    req.files = ordered;
    // El documento de trabajo es el primer job de la secuencia: de él desciende
    // el resultado, aunque se le inserten páginas de otros archivos.
    const firstJob = sources.find((s): s is { jobId: string } => 'jobId' in s);
    req.workSession = { sessionId, parentJobId: firstJob?.jobId ?? null };
    next();
  } catch (error) {
    if (error instanceof ValidationError) {
      await Promise.all(uploaded.map((f) => fs.unlink(f.path).catch(() => undefined)));
    }
    next(error);
  }
};
