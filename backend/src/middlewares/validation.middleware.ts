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
