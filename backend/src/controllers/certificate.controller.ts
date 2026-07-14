import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AppDataSource } from '../config/database';
import { CompressionJob } from '../models/job.model';
import { Certificate, CertificateStatus } from '../models/certificate.model';
import { logger } from '../utils/logger';
import { ValidationError } from '../utils/errors';

/**
 * Emisión de certificados personales firmados por la CA interna.
 *
 * Modelo de ejecución: se crea un job `certificate` (status='pending') SIN
 * archivo original; el worker Python lo recoge, carga la CA (cuya clave privada
 * vive solo en el worker), genera el .pfx y lo registra como archivo de salida.
 * El cliente consulta GET /api/v1/jobs/:jobId y descarga el .pfx con
 * GET /api/v1/jobs/:jobId/download.
 *
 * La contraseña del .pfx viaja de forma transitoria en operation_params; el
 * worker la usa una vez y la destruye (mismo patrón que la firma con .pfx).
 *
 * Ambos endpoints están protegidos por `requireAuth` + `requireRole('admin')`
 * (antes era `requireAdminKey`/`X-Admin-Key`; ahora una sola forma de auth).
 * Se registra al admin emisor: `user_id` en el job y `emitido_por_user_id` en
 * operation_params (el worker lo persiste en certificados_emitidos).
 */
export const issueCertificate = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      nombre,
      cedula,
      email,
      departamento,
      pfxPassword,
      validityYears,
    } = req.body as Record<string, string | undefined>;

    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const jobId = uuidv4();

    const job = jobRepo.create({
      id: jobId,
      userId: req.user?.id ?? null,
      status: 'pending',
      operationType: 'certificate',
      operationParams: {
        nombre,
        cedula: cedula || null,
        email: email || null,
        departamento: departamento || null,
        // Secreto transitorio: el worker lo destruye tras generar el .pfx.
        pfx_password: pfxPassword,
        validity_years: validityYears ? parseInt(validityYears, 10) : undefined,
        emitido_por: 'admin',
        // Auditoría: admin autenticado que emite. El worker lo escribe en
        // certificados_emitidos.emitido_por_user_id.
        emitido_por_user_id: req.user?.id ?? null,
      },
    });

    await jobRepo.save(job);

    logger.info(`Certificate job ${jobId} created for "${nombre}"`);

    res.status(201).json({
      success: true,
      data: {
        jobId,
        status: 'pending',
        operationType: 'certificate',
        nombre,
        createdAt: job.createdAt,
        // El .pfx se descarga cuando el job pase a 'completed'.
        statusUrl: `/api/v1/jobs/${jobId}`,
        downloadUrl: `/api/v1/jobs/${jobId}/download`,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** Lista los certificados emitidos (sin material secreto). */
export const listCertificates = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const estado = req.query.estado as CertificateStatus | undefined;
    if (estado && estado !== 'activo' && estado !== 'revocado') {
      throw new ValidationError("estado debe ser 'activo' o 'revocado'");
    }

    const certRepo = AppDataSource.getRepository(Certificate);
    const certs = await certRepo.find({
      where: estado ? { estado } : {},
      order: { createdAt: 'DESC' },
      take: 500,
    });

    res.json({
      success: true,
      data: certs.map((c) => ({
        serial: c.serial,
        nombre: c.empleadoNombre,
        cedula: c.empleadoCedula,
        email: c.empleadoEmail,
        departamento: c.departamento,
        notBefore: c.notBefore,
        notAfter: c.notAfter,
        estado: c.estado,
        emitidoPor: c.emitidoPor,
        emitidoPorUserId: c.emitidoPorUserId ?? null,
        createdAt: c.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
};
