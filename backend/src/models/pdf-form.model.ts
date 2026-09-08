import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { AppDataSource } from '../config/database';

/**
 * Definición de un formulario PDF rellenable (gestor de formularios).
 *
 * A diferencia de los jobs (efímeros, expiran a 24h), las definiciones son
 * PERSISTENTES: borradores editables y versionados. El PDF final NO se guarda
 * aquí; se genera bajo demanda con la operación de worker `form_generate`.
 *
 * Ownership idéntico a `compression_jobs`: `user_id` nullable + FK ON DELETE
 * SET NULL. Un usuario solo ve/edita los suyos; el admin ve todos; una
 * definición ajena o huérfana responde 404 (no 403).
 */
@Entity('pdf_forms')
export class PdfForm {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ name: 'user_id', type: 'varchar', length: 36, nullable: true })
  userId?: string | null;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** FormDefinition completa (snake_case) tal cual la consume el worker. */
  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}

/** Fila resumida para el listado de mantenimiento. */
export interface PdfFormSummary {
  id: string;
  name: string;
  questionCount: number;
  updatedAt: Date;
}

/**
 * Acceso a datos con ownership. Mismo patrón estático que `JobModel`.
 * `null` en `userId` de los métodos de lectura significa "admin" (sin filtro).
 */
export class PdfFormModel {
  private static repo() {
    return AppDataSource.getRepository(PdfForm);
  }

  /** Lista las definiciones visibles (las del usuario, o todas si admin). */
  static async list(userId: string | null): Promise<PdfForm[]> {
    const qb = this.repo()
      .createQueryBuilder('form')
      .orderBy('form.updatedAt', 'DESC');
    if (userId !== null) {
      qb.where('form.user_id = :userId', { userId });
    }
    return qb.getMany();
  }

  static async findById(id: string): Promise<PdfForm | null> {
    return this.repo().findOne({ where: { id } });
  }

  static async save(form: PdfForm): Promise<PdfForm> {
    return this.repo().save(form);
  }

  static async delete(id: string): Promise<void> {
    await this.repo().delete(id);
  }
}
