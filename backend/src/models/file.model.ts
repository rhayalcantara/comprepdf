import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { CompressionJob } from './job.model';

export type FileType = 'original' | 'compressed' | 'output';

@Entity('files')
export class File {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ name: 'job_id', type: 'varchar', length: 36 })
  jobId!: string;

  @Column({ name: 'file_type', type: 'enum', enum: ['original', 'compressed', 'output'] })
  fileType!: FileType;

  @Column({ type: 'varchar', length: 255 })
  filename!: string;

  @Column({ name: 'original_filename', type: 'varchar', length: 255 })
  originalFilename!: string;

  @Column({ name: 'file_path', type: 'varchar', length: 512 })
  filePath!: string;

  @Column({ name: 'file_size', type: 'bigint' })
  fileSize!: number;

  @Column({ name: 'mime_type', type: 'varchar', length: 100, default: 'application/pdf' })
  mimeType!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  checksum?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamp', nullable: true })
  expiresAt?: Date;

  @ManyToOne(() => CompressionJob, (job) => job.files, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job!: CompressionJob;
}
