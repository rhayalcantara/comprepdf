import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

export type CertificateStatus = 'activo' | 'revocado';

/**
 * Registro de certificados personales emitidos por la CA interna ("Coopaspire CA").
 *
 * Las filas las inserta el worker Python al generar el certificado (es quien
 * conoce el número de serie real). El backend solo lee esta tabla para listar
 * (GET /api/v1/certificates). No contiene material secreto: ni la clave privada
 * del empleado ni la contraseña del .pfx se almacenan aquí.
 */
@Entity('certificados_emitidos')
export class Certificate {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  serial!: string;

  @Column({ name: 'job_id', type: 'varchar', length: 36, nullable: true })
  jobId?: string;

  @Column({ name: 'empleado_nombre', type: 'varchar', length: 255 })
  empleadoNombre!: string;

  @Column({ name: 'empleado_cedula', type: 'varchar', length: 40, nullable: true })
  empleadoCedula?: string;

  @Column({ name: 'empleado_email', type: 'varchar', length: 255, nullable: true })
  empleadoEmail?: string;

  @Column({ name: 'departamento', type: 'varchar', length: 255, nullable: true })
  departamento?: string;

  @Column({ name: 'not_before', type: 'timestamp', nullable: true })
  notBefore?: Date;

  @Column({ name: 'not_after', type: 'timestamp', nullable: true })
  notAfter?: Date;

  @Column({ type: 'enum', enum: ['activo', 'revocado'], default: 'activo' })
  estado!: CertificateStatus;

  @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
  revokedAt?: Date;

  @Column({ name: 'revoked_reason', type: 'varchar', length: 255, nullable: true })
  revokedReason?: string;

  @Column({ name: 'emitido_por', type: 'varchar', length: 100, nullable: true })
  emitidoPor?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
