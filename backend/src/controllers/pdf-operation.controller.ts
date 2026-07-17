import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { AppDataSource } from '../config/database';
import { CompressionJob, OperationType } from '../models/job.model';
import { File } from '../models/file.model';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { ValidationError } from '../utils/errors';
import { sanitizeOutputName } from '../utils/filename';

/**
 * Crea un job de operación PDF: guarda la fila del job (status='pending') con sus
 * parámetros, registra el/los archivo(s) original(es) y responde 201.
 * El worker (poller) recoge el job pendiente directamente desde MySQL.
 */
async function createPdfJob(
  req: Request,
  res: Response,
  operationType: OperationType,
  params: Record<string, unknown>,
  files: Express.Multer.File[],
): Promise<void> {
  const jobRepo = AppDataSource.getRepository(CompressionJob);
  const fileRepo = AppDataSource.getRepository(File);

  const jobId = uuidv4();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + config.upload.fileExpiryHours);

  const fileRecords = files.map((f) =>
    fileRepo.create({
      id: uuidv4(),
      jobId,
      fileType: 'original',
      filename: f.filename,
      originalFilename: f.originalname,
      filePath: path.resolve(f.path),
      fileSize: f.size,
      mimeType: f.mimetype,
      expiresAt,
    }),
  );

  // Orden de los originales (relevante para merge)
  const fileOrder = fileRecords.map((f) => f.id);

  const job = jobRepo.create({
    id: jobId,
    userId: req.user?.id ?? null,
    status: 'pending',
    operationType,
    operationParams: { ...params, file_order: fileOrder },
  });

  await jobRepo.save(job);
  await fileRepo.save(fileRecords);

  logger.info(`PDF job ${jobId} (${operationType}) created with ${files.length} file(s)`);

  res.status(201).json({
    success: true,
    data: {
      jobId,
      status: 'pending',
      operationType,
      createdAt: job.createdAt,
    },
  });
}

/** Verifica magic bytes %PDF- de un archivo ya guardado en disco. */
async function assertIsPdf(file: Express.Multer.File): Promise<void> {
  const buffer = await fs.readFile(file.path);
  if (!buffer.toString('utf-8', 0, 5).startsWith('%PDF-')) {
    await fs.unlink(file.path).catch(() => undefined);
    throw new ValidationError(`Invalid PDF file: ${file.originalname}`);
  }
}

/** Verifica magic bytes PNG (\x89PNG) o JPEG (\xFF\xD8) de la imagen de firma. */
async function assertIsSignatureImage(file: Express.Multer.File): Promise<void> {
  const buffer = await fs.readFile(file.path);
  const isPng =
    buffer.length >= 4 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
  if (!isPng && !isJpeg) {
    throw new ValidationError(`Invalid signature image (must be PNG or JPEG): ${file.originalname}`);
  }
}

/** Borra del disco los archivos subidos (limpieza en caminos de error). */
async function cleanupUploads(files: (Express.Multer.File | undefined)[]): Promise<void> {
  await Promise.all(
    files
      .filter((f): f is Express.Multer.File => f !== undefined)
      .map((f) => fs.unlink(f.path).catch(() => undefined)),
  );
}

export const splitPdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    const mode = req.body.mode === 'ranges' ? 'ranges' : 'individual';
    const params: Record<string, unknown> = { mode, output_name: sanitizeOutputName(req.body.outputName) };
    if (mode === 'ranges') {
      const ranges = parseRanges(req.body.ranges);
      if (ranges.length === 0) throw new ValidationError('At least one range is required');
      params.ranges = ranges;
    }
    await createPdfJob(req, res, 'split', params, [req.file]);
  } catch (error) {
    next(error);
  }
};

export const mergePdfs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length < 2) throw new ValidationError('Merge requires at least 2 PDF files');
    const params: Record<string, unknown> = { output_name: sanitizeOutputName(req.body.outputName) };
    // Selección de páginas por archivo (paralela al orden de `files`). Opcional:
    // ausente ⇒ el worker une cada PDF completo.
    const pageRanges = parseMergePageRanges(req.body.pageRanges, files.length);
    if (pageRanges) params.page_ranges = pageRanges;
    await createPdfJob(req, res, 'merge', params, files);
  } catch (error) {
    next(error);
  }
};

/**
 * Normaliza `pageRanges` de merge: un array (o su forma JSON) paralelo a los
 * archivos subidos, donde cada entrada es "all" o una lista tipo "1-3,5".
 * Devuelve el array normalizado, o `null` si no aporta nada (ausente o todo
 * "all") para que el worker use el comportamiento por defecto (PDF completo).
 */
function parseMergePageRanges(raw: unknown, fileCount: number): string[] | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new ValidationError('pageRanges must be a JSON array');
    }
  }
  if (!Array.isArray(arr)) throw new ValidationError('pageRanges must be an array');
  if (arr.length !== fileCount) {
    throw new ValidationError('pageRanges length must match the number of files');
  }
  const normalized = arr.map((value) => {
    const spec = typeof value === 'string' ? value.trim() : '';
    if (spec === '' || spec.toLowerCase() === 'all') return 'all';
    if (!PAGES_PATTERN.test(spec)) throw new ValidationError(`Invalid page range: "${spec}"`);
    return spec;
  });
  return normalized.every((spec) => spec === 'all') ? null : normalized;
}

export const extractPages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    if (!req.body.pages) throw new ValidationError('pages is required');
    await createPdfJob(req, res, 'extract', {
      pages: req.body.pages,
      output_name: sanitizeOutputName(req.body.outputName),
    }, [req.file]);
  } catch (error) {
    next(error);
  }
};

export const rotatePages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    const degrees = parseInt(req.body.degrees ?? '90', 10);
    if (![90, 180, 270].includes(((degrees % 360) + 360) % 360) && degrees % 90 !== 0) {
      throw new ValidationError('degrees must be a multiple of 90');
    }
    await createPdfJob(req, res, 'rotate', {
      pages: req.body.pages || 'all',
      degrees,
      output_name: sanitizeOutputName(req.body.outputName),
    }, [req.file]);
  } catch (error) {
    next(error);
  }
};

export const protectPdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    if (!req.body.password) throw new ValidationError('password is required');
    await createPdfJob(req, res, 'protect', {
      password: req.body.password,
      owner_password: req.body.ownerPassword || undefined,
      output_name: sanitizeOutputName(req.body.outputName),
    }, [req.file]);
  } catch (error) {
    next(error);
  }
};

export const unlockPdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    if (!req.body.password) throw new ValidationError('password is required');
    await createPdfJob(req, res, 'unlock', {
      password: req.body.password,
      output_name: sanitizeOutputName(req.body.outputName),
    }, [req.file]);
  } catch (error) {
    next(error);
  }
};

const SIGN_MODES = ['certificate', 'drawn', 'combined'] as const;
type SignMode = (typeof SIGN_MODES)[number];

// Formato de páginas estilo extract/rotate: "2", "1,3-5", "1-3,5,8-10"
// (el worker lo re-parsea con parse_page_list; aquí solo validamos la forma).
const PAGES_PATTERN = /^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/;

/** Normaliza el modo de firma: ausente/vacío ⇒ 'certificate'; desconocido ⇒ 400. */
function parseSignMode(raw: unknown): SignMode {
  if (raw === undefined || raw === null || raw === '') return 'certificate';
  if (typeof raw === 'string' && (SIGN_MODES as readonly string[]).includes(raw)) {
    return raw as SignMode;
  }
  throw new ValidationError(`mode must be one of: ${SIGN_MODES.join(', ')}`);
}

/** Valida `pages` para la firma dibujada: ausente/vacío/'all' ⇒ 'all'. */
function parseSignPages(raw: unknown): string {
  if (raw === undefined || raw === null) return 'all';
  if (typeof raw !== 'string') throw new ValidationError('pages must be "all" or a list like "1,3-5"');
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'all') return 'all';
  if (!PAGES_PATTERN.test(trimmed)) {
    throw new ValidationError('pages must be "all" or a list like "1,3-5"');
  }
  return trimmed;
}

/** Parsea una coordenada normalizada de colocación (obligatoria y numérica). */
function parsePlacementNumber(raw: unknown, name: string): number {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    throw new ValidationError(`Signature placement (x, y, w) is required: missing "${name}"`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ValidationError(`Signature placement "${name}" must be a number`);
  }
  return value;
}

/** Valida y devuelve la colocación normalizada: x,y ∈ [0,1]; w ∈ (0,1]. */
function parsePlacement(body: Record<string, unknown>): { x: number; y: number; w: number } {
  const x = parsePlacementNumber(body.x, 'x');
  const y = parsePlacementNumber(body.y, 'y');
  const w = parsePlacementNumber(body.w, 'w');
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    throw new ValidationError('Signature position (x, y) must be between 0 and 1');
  }
  if (w <= 0 || w > 1) {
    throw new ValidationError('Signature width (w) must be greater than 0 and at most 1');
  }
  return { x, y, w };
}

export const signPdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const filesByField = req.files as { [field: string]: Express.Multer.File[] } | undefined;
  const pdf = filesByField?.file?.[0];
  const cert = filesByField?.cert?.[0];
  const signature = filesByField?.signature?.[0];
  try {
    const mode = parseSignMode(req.body.mode);
    const needsCert = mode === 'certificate' || mode === 'combined';
    const needsSignature = mode === 'drawn' || mode === 'combined';

    if (!pdf) throw new ValidationError('PDF file (field "file") is required');
    if (needsCert) {
      if (!cert) throw new ValidationError('Certificate file (field "cert") is required');
      if (!req.body.password) throw new ValidationError('Certificate password is required');
    }

    const params: Record<string, unknown> = {
      mode,
      output_name: sanitizeOutputName(req.body.outputName),
    };

    if (needsSignature) {
      if (!signature) throw new ValidationError('Signature image (field "signature") is required');
      const { x, y, w } = parsePlacement(req.body);
      params.signature_path = path.resolve(signature.path);
      params.pages = parseSignPages(req.body.pages);
      params.x = x;
      params.y = y;
      params.w = w;
    }

    if (needsCert) {
      // La ruta del cert y su contraseña se guardan de forma transitoria en
      // operation_params; el worker las destruye inmediatamente tras firmar.
      params.cert_path = path.resolve(cert!.path);
      params.cert_password = req.body.password;
      params.field_name = req.body.fieldName || undefined;
      params.reason = req.body.reason || undefined;
      params.location = req.body.location || undefined;
    }

    await assertIsPdf(pdf);
    if (needsSignature) await assertIsSignatureImage(signature!);

    await createPdfJob(req, res, 'sign', params, [pdf]);
  } catch (error) {
    // Si una validación falla tras subir archivos, no dejar huérfanos en disco
    // (la imagen de la firma y el cert son datos sensibles).
    if (error instanceof ValidationError) {
      await cleanupUploads([pdf, cert, signature]);
    }
    next(error);
  }
};

// --- Edición de PDF (pdf_edit) ---

/**
 * Tipos de edición aceptados en la Fase A. `redact` (borrado real con PyMuPDF)
 * se añadirá en la Fase B; hasta entonces se rechaza para no degradar en
 * silencio un "borrar" a un "tapar".
 */
const EDIT_TYPES = ['text', 'image', 'whiteout'] as const;
const MAX_EDITS = 200;
const MAX_EDIT_TEXT = 2000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function editFraction(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new ValidationError(`Edit ${field} must be a number between 0 and 1`);
  }
  return n;
}

/**
 * Valida y normaliza una edición. Para `image`, `image_index` referencia una de
 * las imágenes subidas; se traduce a `image_path` (como la firma) y el índice se
 * descarta. Devuelve el objeto limpio que se persiste y se envía al worker.
 */
function validateEdit(raw: unknown, index: number, images: Express.Multer.File[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError(`Edit ${index + 1} is invalid`);
  }
  const e = raw as Record<string, unknown>;

  const type = String(e.type ?? '');
  if (!(EDIT_TYPES as readonly string[]).includes(type)) {
    throw new ValidationError(`Edit ${index + 1} has an invalid type "${type}"`);
  }

  const page = typeof e.page === 'number' ? e.page : Number(e.page);
  if (!Number.isInteger(page) || page < 1 || page > 10000) {
    throw new ValidationError(`Edit ${index + 1} has an invalid page`);
  }

  const out: Record<string, unknown> = {
    type,
    page,
    x: editFraction(e.x, 'x'),
    y: editFraction(e.y, 'y'),
    w: editFraction(e.w, 'w'),
    h: editFraction(e.h, 'h'),
  };

  if (type === 'text' || type === 'whiteout') {
    const text = String(e.text ?? '');
    if (text.length > MAX_EDIT_TEXT) {
      throw new ValidationError(`Edit ${index + 1} text is too long (max ${MAX_EDIT_TEXT})`);
    }
    if (type === 'text' && !text.trim()) {
      throw new ValidationError(`Edit ${index + 1} (text) needs a non-empty text`);
    }
    out.text = text;

    const fontSize = e.font_size === undefined ? 12 : Number(e.font_size);
    if (!Number.isFinite(fontSize) || fontSize < 4 || fontSize > 96) {
      throw new ValidationError(`Edit ${index + 1} font_size must be between 4 and 96`);
    }
    out.font_size = fontSize;

    if (e.color !== undefined) {
      if (!HEX_COLOR.test(String(e.color))) {
        throw new ValidationError(`Edit ${index + 1} color must be a hex like #101828`);
      }
      out.color = String(e.color);
    }
    if (type === 'whiteout' && e.color_text !== undefined) {
      if (!HEX_COLOR.test(String(e.color_text))) {
        throw new ValidationError(`Edit ${index + 1} color_text must be a hex like #101828`);
      }
      out.color_text = String(e.color_text);
    }
  }

  if (type === 'image') {
    const imageIndex = typeof e.image_index === 'number' ? e.image_index : Number(e.image_index);
    if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= images.length) {
      throw new ValidationError(`Edit ${index + 1} references a missing image`);
    }
    out.image_path = path.resolve(images[imageIndex].path);
  }

  return out;
}

export const editPdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const filesByField = req.files as { [field: string]: Express.Multer.File[] } | undefined;
  const pdf = filesByField?.file?.[0];
  const images = filesByField?.images ?? [];
  try {
    if (!pdf) throw new ValidationError('PDF file (field "file") is required');

    let rawEdits: unknown;
    try {
      rawEdits = typeof req.body.edits === 'string' ? JSON.parse(req.body.edits) : req.body.edits;
    } catch {
      throw new ValidationError('edits must be valid JSON');
    }
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
      throw new ValidationError('At least one edit is required');
    }
    if (rawEdits.length > MAX_EDITS) {
      throw new ValidationError(`Too many edits (max ${MAX_EDITS})`);
    }

    const edits = rawEdits.map((e, i) => validateEdit(e, i, images));

    await assertIsPdf(pdf);
    for (const img of images) {
      await assertIsSignatureImage(img);
    }

    await createPdfJob(req, res, 'pdf_edit', {
      edits,
      output_name: sanitizeOutputName(req.body.outputName),
    }, [pdf]);
  } catch (error) {
    if (error instanceof ValidationError) {
      await cleanupUploads([pdf, ...images]);
    }
    next(error);
  }
};

/** Acepta ranges como array JSON, array real, o string separado por comas. */
function parseRanges(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((r) => String(r).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((r) => String(r).trim()).filter(Boolean);
      } catch {
        /* fallthrough */
      }
    }
    return trimmed.split(',').map((r) => r.trim()).filter(Boolean);
  }
  return [];
}
