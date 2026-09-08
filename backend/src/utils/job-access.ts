import { Request } from 'express';
import { NotFoundError, UnauthorizedError } from './errors';

/**
 * Autorización por ownership de un job. Reglas (ver PLAN_USUARIOS §5):
 * - admin: ve/acciona cualquier job.
 * - usuario normal: solo sus propios jobs.
 * - un job de otro usuario o huérfano (`userId` NULL) responde **404** (no 403)
 *   para no revelar la existencia de trabajos ajenos.
 *
 * Debe usarse SIEMPRE tras `requireAuth` (garantiza `req.user`). Vive aquí, y no
 * en un controlador, porque el encadenado de jobs (`resolveSourceJob`) necesita
 * exactamente la misma regla: tomar la salida de un job ajeno como entrada tiene
 * que ser tan imposible —y tan indistinguible— como descargarla.
 */
export function assertJobVisible(job: { userId?: string | null }, req: Request): void {
  const user = req.user;
  if (!user) {
    throw new UnauthorizedError();
  }
  if (user.rol === 'admin') {
    return;
  }
  if (!job.userId || job.userId !== user.id) {
    throw new NotFoundError('Job not found');
  }
}
