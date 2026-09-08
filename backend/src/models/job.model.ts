import { Entity, PrimaryColumn, Column, CreateDateColumn, OneToMany } from 'typeorm';
import { AppDataSource } from '../config/database';
import { File } from './file.model';
import { User } from './user.model';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type CompressionLevel = 'low' | 'medium' | 'high' | 'custom';
export type OperationType =
  | 'compress'
  | 'split'
  | 'merge'
  | 'sign'
  | 'extract'
  | 'rotate'
  | 'protect'
  | 'unlock'
  | 'certificate'
  | 'form_generate'
  | 'pdf_edit'
  | 'organize'
  | 'convert'
  | 'pdf_to_word'
  | 'pdf_to_excel'
  | 'translate';

@Entity('compression_jobs')
export class CompressionJob {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  /**
   * Usuario que creó el job (ownership). Nullable + FK ON DELETE SET NULL:
   * los jobs sin dueño (`user_id` NULL) son huérfanos y solo un admin puede
   * verlos/accionarlos. Ver migración 003_users.sql.
   */
  @Column({ name: 'user_id', type: 'varchar', length: 36, nullable: true })
  userId?: string | null;

  /**
   * Sesión de trabajo del Estudio: agrupa la cadena de operaciones que se aplican
   * sobre un mismo documento abierto. NULL = job suelto (flujo clásico de una
   * sola operación desde /tools/:tool). Ver migración 012.
   */
  @Column({ name: 'session_id', type: 'varchar', length: 36, nullable: true })
  sessionId?: string | null;

  /**
   * Job del que salió la ENTRADA de este job. Lo rellena `resolveSourceJob`
   * cuando la operación se encadena con `sourceJobId` en vez de subir un archivo.
   */
  @Column({ name: 'parent_job_id', type: 'varchar', length: 36, nullable: true })
  parentJobId?: string | null;

  @Column({ type: 'enum', enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' })
  status!: JobStatus;

  @Column({
    name: 'operation_type',
    type: 'enum',
    enum: ['compress', 'split', 'merge', 'sign', 'extract', 'rotate', 'protect', 'unlock', 'certificate', 'form_generate', 'pdf_edit', 'organize', 'convert', 'pdf_to_word', 'pdf_to_excel', 'translate'],
    default: 'compress',
  })
  operationType!: OperationType;

  @Column({ name: 'operation_params', type: 'json', nullable: true })
  operationParams?: Record<string, unknown>;

  @Column({ name: 'compression_level', type: 'enum', enum: ['low', 'medium', 'high', 'custom'], nullable: true })
  compressionLevel?: CompressionLevel;

  @Column({ name: 'custom_dpi', type: 'int', nullable: true })
  customDpi?: number;

  @Column({ name: 'preserve_metadata', type: 'boolean', default: true })
  preserveMetadata!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'started_at', type: 'timestamp', nullable: true })
  startedAt?: Date;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt?: Date;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @OneToMany(() => File, (file) => file.job)
  files!: File[];
}

/** Opciones de paginación para los listados de jobs. */
export interface JobPageOptions {
  page: number;
  limit: number;
}

/** Página de jobs: las filas de esta página y el total sin paginar. */
export interface JobPage {
  jobs: CompressionJob[];
  total: number;
}

/**
 * Acceso a datos de jobs para los listados con ownership. Mismo patrón que
 * `UserModel`: métodos estáticos sobre el repositorio TypeORM.
 */
/**
 * Plegado de sesiones para "Mis trabajos": de una cadena de jobs encadenados en
 * el Estudio solo interesa **el último**, no cada paso intermedio.
 *
 * Un job se muestra si NO es de sesión (`session_id NULL`, el flujo clásico de
 * una sola operación) o si es el más reciente de la suya. El desempate por `id`
 * hace la selección determinista cuando dos pasos comparten `created_at`
 * (posible: MySQL guarda TIMESTAMP con precisión de segundo).
 */
const LATEST_OF_SESSION = `(
  job.session_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM compression_jobs newer
    WHERE newer.session_id = job.session_id
      AND (newer.created_at > job.created_at
           OR (newer.created_at = job.created_at AND newer.id > job.id))
  )
)`;

export class JobModel {
  private static repo() {
    return AppDataSource.getRepository(CompressionJob);
  }

  /**
   * Historial paginado de los jobs de UN usuario (más recientes primero),
   * con los archivos cargados para poder mostrar nombres/estado en el listado.
   * Las sesiones del Estudio se pliegan a su último paso (ver LATEST_OF_SESSION).
   */
  static async listByUser(userId: string, opts: JobPageOptions): Promise<JobPage> {
    const [jobs, total] = await this.repo()
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.files', 'file')
      .where('job.user_id = :userId', { userId })
      .andWhere(LATEST_OF_SESSION)
      .orderBy('job.createdAt', 'DESC')
      .skip((opts.page - 1) * opts.limit)
      .take(opts.limit)
      .getManyAndCount();
    return { jobs, total };
  }

  /**
   * (admin) TODOS los jobs paginados, incluidos los huérfanos (`user_id` NULL).
   * El username del propietario se resuelve aparte con `usernamesByIds` (join
   * batched a `users`), evitando mezclar raw+entities con el join 1:N de files.
   */
  static async listAll(opts: JobPageOptions): Promise<JobPage> {
    const [jobs, total] = await this.repo()
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.files', 'file')
      .where(LATEST_OF_SESSION)
      .orderBy('job.createdAt', 'DESC')
      .skip((opts.page - 1) * opts.limit)
      .take(opts.limit)
      .getManyAndCount();
    return { jobs, total };
  }

  /**
   * Nº de pasos de cada sesión, para que el listado pueda decir "5 operaciones"
   * en el renglón plegado. Una sola consulta agrupada para toda la página.
   */
  static async sessionStepCounts(sessionIds: (string | null | undefined)[]): Promise<Map<string, number>> {
    const unique = [...new Set(sessionIds.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await this.repo()
      .createQueryBuilder('job')
      .select('job.session_id', 'sessionId')
      .addSelect('COUNT(*)', 'steps')
      .where('job.session_id IN (:...ids)', { ids: unique })
      .groupBy('job.session_id')
      .getRawMany<{ sessionId: string; steps: string }>();
    return new Map(rows.map((r) => [r.sessionId, Number(r.steps)]));
  }

  /** Mapa `userId -> username` para adjuntar el propietario en el listado admin. */
  static async usernamesByIds(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) {
      return new Map();
    }
    const users = await AppDataSource.getRepository(User)
      .createQueryBuilder('u')
      .select(['u.id', 'u.username'])
      .where('u.id IN (:...ids)', { ids: unique })
      .getMany();
    return new Map(users.map((u) => [u.id, u.username]));
  }
}
