import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { CompressionJob } from './job.model';

@Entity('compression_stats')
export class CompressionStats {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'job_id', type: 'varchar', length: 36 })
  jobId!: string;

  @Column({ name: 'original_size', type: 'bigint' })
  originalSize!: number;

  @Column({ name: 'compressed_size', type: 'bigint' })
  compressedSize!: number;

  @Column({ name: 'compression_ratio', type: 'decimal', precision: 5, scale: 2 })
  compressionRatio!: number;

  @Column({ name: 'processing_time_ms', type: 'int' })
  processingTimeMs!: number;

  @Column({ name: 'pages_count', type: 'int', nullable: true })
  pagesCount?: number;

  @Column({ name: 'images_count', type: 'int', nullable: true })
  imagesCount?: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => CompressionJob, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job!: CompressionJob;
}
