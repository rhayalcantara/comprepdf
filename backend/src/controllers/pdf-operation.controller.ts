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

/**
 * PDF → Word (.docx). La entrada es un PDF normal (upload + validatePdfFile ya
 * validaron magic bytes), así que aquí solo se crea el job: la comprobación de
 * cifrado/escaneado la hace el worker, que es quien puede abrir el PDF.
 */
export const pdfToWord = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    await createPdfJob(req, res, 'pdf_to_word', {
      output_name: sanitizeOutputName(req.body.outputName),
    }, [req.file]);
  } catch (error) {
    next(error);
  }
};

/**
 * PDF → Excel (.xlsx): extracción de tablas. Mismo pipeline mínimo que
 * pdfToWord; la detección de tablas/cifrado/escaneado la hace el worker.
 */
export const pdfToExcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    await createPdfJob(req, res, 'pdf_to_excel', {
      output_name: sanitizeOutputName(req.body.outputName),
    }, [req.file]);
  } catch (error) {
    next(error);
  }
};

// --- Traducción de PDF (translate) ---

/**
 * Idiomas destino soportados. Solo alfabeto latino: el worker escribe la
 * traducción con la fuente base de PyMuPDF (helv), que no cubre CJK/árabe.
 */
const TRANSLATE_LANGS = ['es', 'en', 'fr', 'pt', 'it', 'de'] as const;

/**
 * Traducir PDF: el worker extrae los bloques de texto, los traduce con el LLM
 * local (Ollama) y los reescribe en su misma posición. La comprobación de
 * cifrado/escaneado la hace el worker, igual que en pdfToWord.
 */
export const translatePdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    const targetLang = String(req.body.targetLang ?? '');
    if (!(TRANSLATE_LANGS as readonly string[]).includes(targetLang)) {
      throw new ValidationError(`targetLang must be one of: ${TRANSLATE_LANGS.join(', ')}`);
    }
    await createPdfJob(req, res, 'translate', {
      target_lang: targetLang,
      output_name: sanitizeOutputName(req.body.outputName),
    }, [req.file]);
  } catch (error) {
    next(error);
  }
};

// --- Conversión a PDF (convert) ---

/**
 * Familias de la conversión y sus magic bytes. La EXTENSIÓN decide qué
 * aplicación convertirá (el multer ya filtró la whitelist); los magic bytes
 * confirman que el contenido pertenece a esa familia — un .docx renombrado
 * a .xlsx pasa (misma familia ZIP), pero un .exe renombrado a .docx no.
 */
type ConvertFamily = 'zip' | 'ole' | 'rtf' | 'jpeg' | 'png' | 'text';

const CONVERT_FAMILY_BY_EXT: Record<string, ConvertFamily> = {
  '.docx': 'zip', '.xlsx': 'zip', '.pptx': 'zip',
  '.odt': 'zip', '.ods': 'zip', '.odp': 'zip',
  '.doc': 'ole', '.xls': 'ole', '.ppt': 'ole',
  '.rtf': 'rtf',
  '.jpg': 'jpeg', '.jpeg': 'jpeg',
  '.png': 'png',
  '.txt': 'text',
};

function matchesFamily(buffer: Buffer, family: ConvertFamily): boolean {
  switch (family) {
    case 'zip':  // OOXML y OpenDocument son contenedores ZIP
      return buffer.length >= 4 &&
        buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
    case 'ole':  // formato binario legado de Office (Compound File)
      return buffer.length >= 4 &&
        buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
    case 'rtf':
      return buffer.toString('latin1', 0, 5).startsWith('{\\rtf');
    case 'jpeg':
      return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
    case 'png':
      return buffer.length >= 4 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    case 'text':  // sin magic: rechazar binario (bytes NUL en el primer KB)
      return !buffer.subarray(0, 1024).includes(0);
  }
}

export const convertToPdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');
    const ext = path.extname(req.file.originalname).toLowerCase();
    const family = CONVERT_FAMILY_BY_EXT[ext];
    if (!family) {
      // El multer ya filtra; esto cubre llamadas que lo esquiven.
      throw new ValidationError(`Unsupported file type "${ext || '(none)'}" for conversion`);
    }

    const buffer = await fs.readFile(req.file.path);
    if (buffer.length === 0) throw new ValidationError('The uploaded file is empty');
    if (!matchesFamily(buffer, family)) {
      throw new ValidationError(`File content does not match its "${ext}" extension`);
    }

    await createPdfJob(req, res, 'convert', {
      source_ext: ext.slice(1),
      output_name: sanitizeOutputName(req.body.outputName),
    }, [req.file]);
  } catch (error) {
    if (error instanceof ValidationError) {
      await cleanupUploads([req.file]);
    }
    next(error);
  }
};

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

/**
 * Organiza las páginas: reordenar, eliminar y rotar en una sola pasada.
 *
 * `pages` es la lista FINAL de páginas (JSON), en el orden deseado: cada entrada
 * dice de qué página del original sale (`source`, 1-based) y con qué rotación
 * relativa (`rotate`, múltiplo de 90). Eliminar una página = no incluirla; la
 * lista no puede quedar vacía porque un PDF sin páginas no es válido.
 */
export const organizePdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) throw new ValidationError('No file uploaded');

    let raw: unknown;
    try {
      raw = typeof req.body.pages === 'string' ? JSON.parse(req.body.pages) : req.body.pages;
    } catch {
      throw new ValidationError('pages must be valid JSON');
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ValidationError('pages must be a non-empty array');
    }
    if (raw.length > MAX_ORGANIZE_PAGES) {
      throw new ValidationError(`Too many pages (max ${MAX_ORGANIZE_PAGES})`);
    }

    const pages = raw.map(validateOrganizePage);

    await createPdfJob(req, res, 'organize', {
      pages,
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
      const stamp = parseStamp(req.body.stamp);
      if (stamp) params.stamp = stamp;
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

// --- Sello de texto bajo la firma dibujada ---

const MAX_STAMP_TEXT = 60;
const STAMP_FORMATS = ['datetime', 'date'] as const;

/** Acepta 'true'/'false' además de booleanos (multipart manda todo como texto). */
function parseBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/**
 * Valida el sello opcional que acompaña a la firma dibujada y lo normaliza.
 *
 * La fecha NO viaja desde el navegador: aquí solo se dice SI se quiere y en qué
 * formato; el worker la calcula al procesar, que es lo que la hace evidencia.
 * Un sello sin etiqueta ni fecha es un error explícito, no un sello vacío.
 */
function parseStamp(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ValidationError('stamp must be valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('stamp must be an object');
  }
  const s = parsed as Record<string, unknown>;

  const text = String(s.text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (text.length > MAX_STAMP_TEXT) {
    throw new ValidationError(`Stamp text is too long (max ${MAX_STAMP_TEXT})`);
  }
  const showDatetime = parseBool(s.show_datetime);
  if (!text && !showDatetime) {
    throw new ValidationError('Stamp needs a text or the date');
  }

  const format = String(s.datetime_format ?? 'datetime');
  if (!(STAMP_FORMATS as readonly string[]).includes(format)) {
    throw new ValidationError('Stamp datetime_format must be "datetime" or "date"');
  }

  const color = s.color === undefined || s.color === '' ? '#B42318' : String(s.color);
  if (!HEX_COLOR.test(color)) {
    throw new ValidationError('Stamp color must be a hex color like #B42318');
  }

  return {
    text,
    show_datetime: showDatetime,
    datetime_format: format,
    color,
    border: parseBool(s.border),
  };
}

// --- Edición de PDF (pdf_edit) ---

/**
 * Tipos de edición aceptados en la Fase A. `redact` (borrado real con PyMuPDF)
 * se añadirá en la Fase B; hasta entonces se rechaza para no degradar en
 * silencio un "borrar" a un "tapar".
 */
const EDIT_TYPES = [
  'text', 'image', 'whiteout',
  // Fase 1 de marcado (tipo Acrobat): formas vectoriales sobre la caja x,y,w,h.
  'highlight', 'underline', 'strikeout', 'line', 'arrow', 'rect', 'ellipse', 'mark',
] as const;

/** Tipos con trazo: aceptan stroke_width; line/arrow además aceptan dir. */
const STROKE_TYPES = ['highlight', 'underline', 'strikeout', 'line', 'arrow', 'rect', 'ellipse', 'mark'] as const;
const LINE_DIRS = ['up', 'down'] as const;
const MARK_KINDS = ['cross', 'check', 'dot'] as const;
const MIN_STROKE_WIDTH = 0.5;
const MAX_STROKE_WIDTH = 12;
const MAX_ORGANIZE_PAGES = 5000;

/**
 * Valida una entrada de `pages` de la operación organize y la normaliza a
 * `{ source, rotate }`. `source` es 1-based sobre el PDF original (el worker
 * comprueba que exista de verdad); `rotate` se normaliza a 0/90/180/270, así que
 * un -90 del frontend llega como 270.
 */
function validateOrganizePage(raw: unknown, index: number): { source: number; rotate: number } {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const source = typeof p.source === 'number' ? p.source : Number(p.source);
  if (!Number.isInteger(source) || source < 1 || source > 10000) {
    throw new ValidationError(`Page ${index + 1} has an invalid source`);
  }

  const rotate = p.rotate === undefined || p.rotate === '' ? 0 : Number(p.rotate);
  if (!Number.isInteger(rotate) || rotate % 90 !== 0) {
    throw new ValidationError(`Page ${index + 1} rotate must be a multiple of 90`);
  }

  return { source, rotate: ((rotate % 360) + 360) % 360 };
}

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

  if ((STROKE_TYPES as readonly string[]).includes(type)) {
    if (e.color !== undefined) {
      if (!HEX_COLOR.test(String(e.color))) {
        throw new ValidationError(`Edit ${index + 1} color must be a hex like #B42318`);
      }
      out.color = String(e.color);
    }
    if (e.stroke_width !== undefined) {
      const strokeWidth = Number(e.stroke_width);
      if (!Number.isFinite(strokeWidth) || strokeWidth < MIN_STROKE_WIDTH || strokeWidth > MAX_STROKE_WIDTH) {
        throw new ValidationError(
          `Edit ${index + 1} stroke_width must be between ${MIN_STROKE_WIDTH} and ${MAX_STROKE_WIDTH}`,
        );
      }
      out.stroke_width = strokeWidth;
    }
    if (type === 'line' || type === 'arrow') {
      const dir = e.dir === undefined ? 'up' : String(e.dir);
      if (!(LINE_DIRS as readonly string[]).includes(dir)) {
        throw new ValidationError(`Edit ${index + 1} dir must be 'up' or 'down'`);
      }
      out.dir = dir;
    }
    if (type === 'mark') {
      const mark = e.mark === undefined ? 'check' : String(e.mark);
      if (!(MARK_KINDS as readonly string[]).includes(mark)) {
        throw new ValidationError(`Edit ${index + 1} mark must be one of: ${MARK_KINDS.join(', ')}`);
      }
      out.mark = mark;
    }
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
