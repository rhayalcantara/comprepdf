import { Request, Response, NextFunction } from 'express';
import { CompressionJob, JobModel } from '../models/job.model';
import { UnauthorizedError } from '../utils/errors';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Parsea `page` (>=1, por defecto 1). */
function parsePage(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_PAGE;
}

/** Parsea `limit` (1..MAX_LIMIT, por defecto 20). */
function parseLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(n, MAX_LIMIT);
}

/**
 * Serializa un job para el listado "Mis trabajos". Incluye `username` SOLO en el
 * modo admin (`username !== undefined`), tomándolo del mapa id→username.
 */
function serializeJobSummary(
  job: CompressionJob,
  username?: string | null,
  sessionSteps?: number,
): Record<string, unknown> {
  const files = job.files ?? [];
  const originalFile = files.find((f) => f.fileType === 'original');
  const resultFile = files.find(
    (f) => f.fileType === 'compressed' || f.fileType === 'output',
  );

  const item: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    operationType: job.operationType,
    // Sesión del Estudio: el renglón representa la cadena completa, no un paso.
    // `sessionSteps` es cuántas operaciones se aplicaron sobre el documento.
    sessionId: job.sessionId ?? null,
    sessionSteps: job.sessionId ? sessionSteps ?? 1 : null,
    compressionLevel: job.compressionLevel ?? null,
    originalFilename: originalFile?.originalFilename ?? null,
    originalSize: originalFile ? Number(originalFile.fileSize) : null,
    outputFilename: resultFile?.originalFilename ?? null,
    outputSize: resultFile ? Number(resultFile.fileSize) : null,
    downloadUrl: resultFile ? `/api/v1/jobs/${job.id}/download` : null,
    createdAt: job.createdAt,
    completedAt: job.completedAt ?? null,
    expiresAt: resultFile?.expiresAt ?? null,
  };

  if (username !== undefined) {
    item.username = username;
  }
  return item;
}

/**
 * GET /jobs — historial paginado del usuario autenticado ("Mis trabajos").
 *
 * - Usuario normal: solo sus jobs (`user_id = req.user.id`).
 * - Admin con `?all=true`: TODOS los jobs (incluye huérfanos) con el `username`
 *   del propietario. Sin `?all=true`, el admin ve solo los suyos.
 *
 * Query params: `page` (>=1, def. 1), `limit` (1..100, def. 20), `all` (admin).
 * Respuesta: `{ success, data: { items, pagination: { page, limit, total, totalPages } } }`.
 * Debe montarse tras `requireAuth`.
 */
export const listJobs = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const wantsAll = req.query.all === 'true';
    const asAdmin = wantsAll && req.user.rol === 'admin';

    let jobs: CompressionJob[];
    let total: number;
    let items: Record<string, unknown>[];

    if (asAdmin) {
      ({ jobs, total } = await JobModel.listAll({ page, limit }));
      const usernames = await JobModel.usernamesByIds(jobs.map((j) => j.userId));
      const steps = await JobModel.sessionStepCounts(jobs.map((j) => j.sessionId));
      items = jobs.map((j) =>
        serializeJobSummary(
          j,
          j.userId ? usernames.get(j.userId) ?? null : null,
          j.sessionId ? steps.get(j.sessionId) : undefined,
        ),
      );
    } else {
      ({ jobs, total } = await JobModel.listByUser(req.user.id, { page, limit }));
      const steps = await JobModel.sessionStepCounts(jobs.map((j) => j.sessionId));
      items = jobs.map((j) =>
        serializeJobSummary(j, undefined, j.sessionId ? steps.get(j.sessionId) : undefined),
      );
    }

    res.json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
