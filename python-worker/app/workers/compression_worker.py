import time
import uuid
from pathlib import Path
from celery import Celery
import mysql.connector

from app.config import settings
from app.compression.ghostscript import GhostscriptCompressor
from app.compression.pdf_analyzer import PdfAnalyzer

celery_app = Celery('compression_worker')
celery_app.config_from_object('celeryconfig')

compressor = GhostscriptCompressor()
analyzer = PdfAnalyzer()


@celery_app.task(bind=True, max_retries=3, name='compress-pdf')
def process_compression_job(self, job_id: str, **kwargs):
    """Procesa un trabajo de compresión."""
    start_time = time.time()
    conn = None
    cursor = None

    try:
        conn = mysql.connector.connect(**settings.MYSQL_CONFIG)
        cursor = conn.cursor(dictionary=True)

        # Obtener job y archivo original
        cursor.execute("""
            SELECT j.*, f.file_path, f.original_filename
            FROM compression_jobs j
            JOIN files f ON f.job_id = j.id
            WHERE j.id = %s AND f.file_type = 'original'
        """, (job_id,))
        job = cursor.fetchone()

        if not job:
            raise Exception(f"Job {job_id} not found")

        # Actualizar estado a processing
        cursor.execute("""
            UPDATE compression_jobs
            SET status = 'processing', started_at = NOW()
            WHERE id = %s
        """, (job_id,))
        conn.commit()

        # Preparar paths
        input_path = Path(job['file_path'])
        output_filename = f"compressed_{job['original_filename']}"
        output_path = Path(settings.OUTPUT_DIR) / output_filename

        # Asegurar que existe el directorio de salida
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Analizar PDF antes de comprimir
        pdf_info = analyzer.analyze(input_path)
        print(f"PDF Analysis - Pages: {pdf_info['pages_count']}, Images: {pdf_info['images_count']}")

        # Validar que no esté encriptado
        if pdf_info.get('is_encrypted'):
            raise Exception("Cannot compress encrypted PDF")

        # Comprimir
        result = compressor.compress(
            input_path=input_path,
            output_path=output_path,
            level=job['compression_level'],
            custom_dpi=job.get('custom_dpi')
        )

        processing_time = int((time.time() - start_time) * 1000)
        compression_ratio = round(
            (1 - result['compressed_size'] / result['original_size']) * 100, 2
        )

        # Guardar archivo comprimido en DB
        file_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO files (id, job_id, file_type, filename, original_filename,
                              file_path, file_size, expires_at)
            VALUES (%s, %s, 'compressed', %s, %s, %s, %s,
                    DATE_ADD(NOW(), INTERVAL 24 HOUR))
        """, (file_id, job_id, output_filename, job['original_filename'],
              str(output_path), result['compressed_size']))

        # Guardar estadísticas
        cursor.execute("""
            INSERT INTO compression_stats
            (job_id, original_size, compressed_size, compression_ratio, processing_time_ms,
             pages_count, images_count)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (job_id, result['original_size'], result['compressed_size'],
              compression_ratio, processing_time,
              pdf_info.get('pages_count'), pdf_info.get('images_count')))

        # Actualizar estado a completed
        cursor.execute("""
            UPDATE compression_jobs
            SET status = 'completed', completed_at = NOW()
            WHERE id = %s
        """, (job_id,))

        conn.commit()

        print(f"Job {job_id} completed. Ratio: {compression_ratio}%")
        return {'status': 'completed', 'job_id': job_id, 'compression_ratio': compression_ratio}

    except Exception as e:
        if conn and cursor:
            cursor.execute("""
                UPDATE compression_jobs
                SET status = 'failed', error_message = %s
                WHERE id = %s
            """, (str(e), job_id))
            conn.commit()

        print(f"Job {job_id} failed: {e}")
        raise self.retry(exc=e, countdown=60)

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()
