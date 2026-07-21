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
  | 'pdf_to_word';

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

  @Column({ type: 'enum', enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' })
  status!: JobStatus;

  @Column({
    name: 'operation_type',
    type: 'enum',
    enum: ['compress', 'split', 'merge', 'sign', 'extract', 'rotate', 'protect', 'unlock', 'certificate', 'form_generate', 'pdf_edit', 'organize', 'convert', 'pdf_to_word'],
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
export class JobModel {
  private static repo() {
    return AppDataSource.getRepository(CompressionJob);
  }

  /**
   * Historial paginado de los jobs de UN usuario (más recientes primero),
   * con los archivos cargados para poder mostrar nombres/estado en el listado.
   */
  static async listByUser(userId: string, opts: JobPageOptions): Promise<JobPage> {
    const [jobs, total] = await this.repo()
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.files', 'file')
      .where('job.user_id = :userId', { userId })
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
      .orderBy('job.createdAt', 'DESC')
      .skip((opts.page - 1) * opts.limit)
      .take(opts.limit)
      .getManyAndCount();
    return { jobs, total };
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
