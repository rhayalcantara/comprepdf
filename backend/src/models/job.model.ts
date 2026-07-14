import { Entity, PrimaryColumn, Column, CreateDateColumn, OneToMany } from 'typeorm';
import { File } from './file.model';

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
  | 'certificate';

@Entity('compression_jobs')
export class CompressionJob {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'enum', enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' })
  status!: JobStatus;

  @Column({
    name: 'operation_type',
    type: 'enum',
    enum: ['compress', 'split', 'merge', 'sign', 'extract', 'rotate', 'protect', 'unlock', 'certificate'],
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
