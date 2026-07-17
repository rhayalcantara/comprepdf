import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/env';
import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../utils/errors';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.upload.uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'));
  }
};

const limits = {
  fileSize: config.upload.maxFileSizeMB * 1024 * 1024,
};

// Subida de un solo PDF (compress, split, extract, rotate, protect, unlock)
export const upload = multer({ storage, fileFilter, limits });

// Subida de múltiples PDFs (merge)
export const uploadMultiple = multer({ storage, fileFilter, limits });

// Imagen de la firma dibujada (campo 'signature'): solo PNG/JPEG, máx 2MB.
export const SIGNATURE_MAX_SIZE_MB = 2;
const SIGNATURE_MIMETYPES = ['image/png', 'image/jpeg'];

// Firma: 'file' (PDF) y 'cert' (.pfx/.p12) sin filtro de mimetype (igual que
// antes); 'signature' solo acepta image/png o image/jpeg.
const signFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.fieldname === 'signature' && !SIGNATURE_MIMETYPES.includes(file.mimetype)) {
    cb(new ValidationError('Signature image must be a PNG or JPEG file'));
    return;
  }
  cb(null, true);
};

// Firma: PDF en 'file' + certificado en 'cert' + imagen dibujada en 'signature'
export const uploadSign = multer({ storage, fileFilter: signFileFilter, limits });

// Edición de PDF: 'file' debe ser PDF; 'images' (sellos/logos a estampar) solo
// PNG/JPEG. El tamaño de cada imagen se acota luego en el controlador.
const editFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.fieldname === 'file' && file.mimetype !== 'application/pdf') {
    cb(new ValidationError('The document must be a PDF file'));
    return;
  }
  if (file.fieldname === 'images' && !SIGNATURE_MIMETYPES.includes(file.mimetype)) {
    cb(new ValidationError('Images must be PNG or JPEG files'));
    return;
  }
  cb(null, true);
};

export const uploadEdit = multer({ storage, fileFilter: editFileFilter, limits });

/**
 * multer solo soporta `limits.fileSize` por instancia (aquí el máximo global
 * de config.upload.maxFileSizeMB, que sigue aplicando a 'file' y 'cert'), así
 * que el límite propio de 2MB de la firma se valida justo después de la
 * subida. Si se excede, se borran TODOS los archivos de la request y se
 * responde 400.
 */
export const enforceSignatureSizeLimit = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const filesByField = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const signature = filesByField?.signature?.[0];
    if (signature && signature.size > SIGNATURE_MAX_SIZE_MB * 1024 * 1024) {
      const uploaded = Object.values(filesByField ?? {}).reduce<Express.Multer.File[]>(
        (acc, group) => acc.concat(group),
        [],
      );
      await Promise.all(uploaded.map((f) => fs.unlink(f.path).catch(() => undefined)));
      next(new ValidationError(`Signature image exceeds ${SIGNATURE_MAX_SIZE_MB}MB limit`));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};
