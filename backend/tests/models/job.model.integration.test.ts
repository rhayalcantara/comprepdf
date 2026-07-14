/**
 * Test de INTEGRACIÓN contra la MySQL local para `JobModel.listByUser` /
 * `listAll`.
 *
 * ¿Por qué integración y no unit con mocks? El bug que cubre este test vivía en
 * el QueryBuilder de TypeORM: ordenar por el *nombre de columna* (`job.created_at`)
 * en lugar de la *propiedad de la entidad* (`job.createdAt`), combinado con
 * `leftJoinAndSelect('job.files')` (relación 1:N) + paginación real (`skip`/`take`).
 * En ese caso TypeORM genera una subconsulta DISTINCT de ids para paginar y, al
 * mapear el `ORDER BY`, busca la metadata de la columna por *propiedad*; con el
 * nombre de columna crudo la metadata es `undefined` y revienta con
 * `Cannot read properties of undefined (reading 'databaseName')`.
 *
 * Ese camino (distinct + join 1:N + skip/take) SOLO se ejercita con una BD real
 * y varias filas con files asociados. Mockear el repositorio no reproduce el
 * bug porque el fallo ocurre dentro del propio generador de SQL de TypeORM.
 *
 * Este archivo NO mockea `src/config/database`, así que usa el `AppDataSource`
 * real (credenciales de `.env`). Si la BD no está disponible, los tests se
 * saltan con un aviso en vez de romper la suite (p.ej. en CI sin MySQL).
 */
import { AppDataSource } from '../../src/config/database';
import { JobModel } from '../../src/models/job.model';

// IDs únicos por corrida para no chocar con datos existentes ni entre corridas.
const TAG = `itest-${Date.now()}`;
const USER_A = `${TAG}-userA`;
const USER_B = `${TAG}-userB`;

// 5 jobs para A y 2 para B, con created_at escalonado (minuto a minuto).
// Orden esperado DESC (más reciente primero): A5, A4, A3, A2, A1.
const A_JOBS = [1, 2, 3, 4, 5].map((n) => ({ id: `${TAG}-A${n}`, minute: n }));
const B_JOBS = [1, 2].map((n) => ({ id: `${TAG}-B${n}`, minute: n }));
// Base temporal fija y lejana en el pasado para que el orden sea determinista.
const BASE = new Date('2020-01-01T00:00:00Z');

let dbReady = false;

async function seed(): Promise<void> {
  const q = (sql: string, params: unknown[]) => AppDataSource.query(sql, params);

  for (const [uid, uname] of [
    [USER_A, `${TAG}-a`],
    [USER_B, `${TAG}-b`],
  ]) {
    await q(
      `INSERT INTO users (id, username, nombre, password_hash, rol, estado) VALUES (?, ?, ?, ?, 'user', 'activo')`,
      [uid, uname, uname, 'x'],
    );
  }

  const insertJob = async (jobId: string, userId: string, minute: number) => {
    const createdAt = new Date(BASE.getTime() + minute * 60_000);
    await q(
      `INSERT INTO compression_jobs (id, user_id, status, operation_type, created_at) VALUES (?, ?, 'completed', 'compress', ?)`,
      [jobId, userId, createdAt],
    );
    // Dos files por job: fuerza el camino DISTINCT de paginación con join 1:N.
    for (const ft of ['original', 'output']) {
      await q(
        `INSERT INTO files (id, job_id, file_type, filename, original_filename, file_path, file_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`${jobId}-${ft}`, jobId, ft, `${ft}.pdf`, `${ft}.pdf`, `/tmp/${ft}.pdf`, 100],
      );
    }
  };

  for (const j of A_JOBS) await insertJob(j.id, USER_A, j.minute);
  for (const j of B_JOBS) await insertJob(j.id, USER_B, j.minute);
}

async function cleanup(): Promise<void> {
  const ids = [...A_JOBS, ...B_JOBS].map((j) => j.id);
  const placeholders = ids.map(() => '?').join(',');
  await AppDataSource.query(`DELETE FROM files WHERE job_id IN (${placeholders})`, ids);
  await AppDataSource.query(`DELETE FROM compression_jobs WHERE id IN (${placeholders})`, ids);
  await AppDataSource.query(`DELETE FROM users WHERE id IN (?, ?)`, [USER_A, USER_B]);
}

beforeAll(async () => {
  try {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
    await cleanup(); // por si una corrida previa quedó a medias
    await seed();
    dbReady = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[job.model.integration] MySQL no disponible; tests SALTADOS: ${(err as Error).message}`,
    );
  }
});

afterAll(async () => {
  if (dbReady) {
    await cleanup();
  }
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
});

/** `it` que se salta (con aviso) si la BD no arrancó, para no dar falso rojo en CI. */
const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!dbReady) {
      // eslint-disable-next-line no-console
      console.warn(`[job.model.integration] SKIP (sin BD): ${name}`);
      return;
    }
    await fn();
  });

describe('JobModel.listByUser (integración MySQL: join 1:N + paginación)', () => {
  dbIt('página 1: respeta el limit, total sin paginar, y orden createdAt DESC', async () => {
    const { jobs, total } = await JobModel.listByUser(USER_A, { page: 1, limit: 3 });

    // El bug viejo (orderBy 'job.created_at') lanzaba aquí:
    // "Cannot read properties of undefined (reading 'databaseName')".
    expect(total).toBe(5); // total sin paginar, no la longitud de la página
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.id)).toEqual([`${TAG}-A5`, `${TAG}-A4`, `${TAG}-A3`]);

    // Orden estrictamente descendente por createdAt.
    for (let i = 1; i < jobs.length; i++) {
      expect(jobs[i - 1].createdAt.getTime()).toBeGreaterThan(jobs[i].createdAt.getTime());
    }

    // Los files 1:N vienen cargados (2 por job) por el leftJoinAndSelect.
    expect(jobs.every((j) => j.files && j.files.length === 2)).toBe(true);
  });

  dbIt('página 2: devuelve el resto respetando el orden', async () => {
    const { jobs, total } = await JobModel.listByUser(USER_A, { page: 2, limit: 3 });
    expect(total).toBe(5);
    expect(jobs.map((j) => j.id)).toEqual([`${TAG}-A2`, `${TAG}-A1`]);
  });

  dbIt('aísla por usuario: nunca trae jobs de otro usuario', async () => {
    const { jobs, total } = await JobModel.listByUser(USER_A, { page: 1, limit: 100 });
    expect(total).toBe(5);
    const bIds = new Set(B_JOBS.map((j) => j.id));
    expect(jobs.some((j) => bIds.has(j.id))).toBe(false);
    expect(jobs.every((j) => j.userId === USER_A)).toBe(true);
  });
});

describe('JobModel.listAll (integración MySQL: join 1:N + paginación)', () => {
  dbIt('pagina sin romper y devuelve la página en orden createdAt DESC', async () => {
    // No podemos fijar el total global (hay datos preexistentes), pero SÍ que
    // la consulta no revienta, que respeta el limit y que la página va DESC.
    const { jobs, total } = await JobModel.listAll({ page: 1, limit: 5 });
    expect(total).toBeGreaterThanOrEqual(7); // al menos nuestros 5 + 2
    expect(jobs.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < jobs.length; i++) {
      expect(jobs[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(jobs[i].createdAt.getTime());
    }
  });

  dbIt('incluye jobs huérfanos/con dueño y carga sus files', async () => {
    // Recorremos hasta encontrar nuestros jobs (creados en 2020, van al final).
    const { total } = await JobModel.listAll({ page: 1, limit: 1 });
    const all = await JobModel.listAll({ page: 1, limit: total });
    const mine = all.jobs.filter((j) => j.id.startsWith(TAG));
    expect(mine).toHaveLength(7);
    expect(mine.every((j) => j.files && j.files.length === 2)).toBe(true);
  });
});
