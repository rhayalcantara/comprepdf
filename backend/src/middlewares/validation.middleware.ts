import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import fs from 'fs/promises';

export const validatePdfFile = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: { message: 'No file uploaded' } });
      return;
    }

    // Verificar magic bytes del PDF
    const buffer = await fs.readFile(req.file.path);
    const magicBytes = buffer.toString('utf-8', 0, 5);

    if (!magicBytes.startsWith('%PDF-')) {
      await fs.unlink(req.file.path); // Eliminar archivo inválido
      res.status(400).json({ success: false, error: { message: 'Invalid PDF file format' } });
      return;
    }

    // Validar tamaño (ya validado por multer, pero doble check)
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (req.file.size > maxSize) {
      await fs.unlink(req.file.path);
      res.status(400).json({ success: false, error: { message: 'File size exceeds 50MB limit' } });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Valida magic bytes de un arreglo de archivos (merge)
export const validatePdfFiles = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ success: false, error: { message: 'No files uploaded' } });
      return;
    }
    if (files.length < 2) {
      res.status(400).json({ success: false, error: { message: 'Merge requires at least 2 PDF files' } });
      return;
    }

    for (const file of files) {
      const buffer = await fs.readFile(file.path);
      if (!buffer.toString('utf-8', 0, 5).startsWith('%PDF-')) {
        await Promise.all(files.map(f => fs.unlink(f.path).catch(() => undefined)));
        res.status(400).json({ success: false, error: { message: `Invalid PDF file: ${file.originalname}` } });
        return;
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Valida el payload de emisión de un certificado personal.
export const validateCertificateRequest = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const schema = Joi.object({
    nombre: Joi.string().trim().min(2).max(120).required(),
    // Al menos uno de cédula o correo como identificador del empleado.
    cedula: Joi.string().trim().max(40).allow('', null),
    email: Joi.string().trim().email().max(255).allow('', null),
    departamento: Joi.string().trim().max(120).allow('', null),
    // Contraseña que protegerá el .pfx del empleado.
    pfxPassword: Joi.string().min(6).max(200).required(),
    validityYears: Joi.number().integer().min(1).max(5).optional(),
  }).or('cedula', 'email');

  const { error, value } = schema.validate(req.body);

  if (error) {
    res.status(400).json({
      success: false,
      error: { message: error.details[0].message },
    });
    return;
  }

  req.body = value;
  next();
};

export const validateCompressionOptions = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const schema = Joi.object({
    compressionLevel: Joi.string().valid('low', 'medium', 'high', 'custom').default('medium'),
    preserveMetadata: Joi.boolean().default(true),
    customDpi: Joi.number().integer().min(50).max(600).when('compressionLevel', {
      is: 'custom',
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    res.status(400).json({
      success: false,
      error: { message: error.details[0].message },
    });
    return;
  }

  req.body = value;
  next();
};
