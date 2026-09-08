"""Worker por polling a MySQL.

Reemplaza el broker (BullMQ/Celery incompatibles). El backend Node inserta la
fila del job en `compression_jobs` (status='pending') y este proceso la reclama,
la procesa según `operation_type` y actualiza el estado. Seguro para múltiples
réplicas gracias a `FOR UPDATE SKIP LOCKED` (MySQL 8 + InnoDB).
"""
import time

import mysql.connector

from app.config import settings
from app.operations.compress import handle_compress
from app.operations.pdf_ops import (
    handle_extract,
    handle_merge,
    handle_organize,
    handle_protect,
    handle_rotate,
    handle_split,
    handle_unlock,
)
from app.operations.sign import handle_sign
from app.operations.certificate import handle_certificate
from app.operations.form_generate import handle_form_generate
from app.operations.pdf_edit import handle_pdf_edit
from app.operations.convert import handle_convert
from app.operations.pdf_to_word import handle_pdf_to_word
from app.operations.pdf_to_excel import handle_pdf_to_excel
from app.operations.pdf_translate import handle_translate

HANDLERS = {
    'compress': handle_compress,
    'split': handle_split,
    'merge': handle_merge,
    'extract': handle_extract,
    'rotate': handle_rotate,
    'protect': handle_protect,
    'unlock': handle_unlock,
    'sign': handle_sign,
    'certificate': handle_certificate,
    'form_generate': handle_form_generate,
    'pdf_edit': handle_pdf_edit,
    'organize': handle_organize,
    'convert': handle_convert,
    'pdf_to_word': handle_pdf_to_word,
    'pdf_to_excel': handle_pdf_to_excel,
    'translate': handle_translate,
}

POLL_INTERVAL = 2  # segundos entre sondeos cuando no hay trabajo


def claim_next_job(conn):
    """Reclama atómicamente el siguiente job pendiente (o None)."""
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT * FROM compression_jobs
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
            """
        )
        job = cursor.fetchone()
        if not job:
            conn.commit()  # cierra la transacción implícita
            return None
        cursor.execute(
            "UPDATE compression_jobs SET status = 'processing', started_at = NOW() WHERE id = %s",
            (job['id'],),
        )
        conn.commit()
        return job
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()


def process_job(conn, job):
    job_id = job['id']
    op = job.get('operation_type') or 'compress'
    handler = HANDLERS.get(op)
    cursor = conn.cursor(dictionary=True)
    try:
        if handler is None:
            raise ValueError(f"Unknown operation_type: {op}")
        handler(job, cursor)
        cursor.execute(
            "UPDATE compression_jobs SET status = 'completed', completed_at = NOW() WHERE id = %s",
            (job_id,),
        )
        conn.commit()
        print(f"[poller] job {job_id} ({op}) completed")
    except Exception as e:
        conn.rollback()
        _mark_failed(conn, job_id, str(e))
        print(f"[poller] job {job_id} ({op}) failed: {e}")
    finally:
        cursor.close()


def _mark_failed(conn, job_id, message):
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE compression_jobs SET status = 'failed', error_message = %s WHERE id = %s",
            (message[:2000], job_id),
        )
        conn.commit()
        cur.close()
    except Exception:
        pass


def main():
    print("[poller] starting MySQL polling worker")
    # Qué motor Office→PDF tocó (com en Windows, libreoffice en el contenedor,
    # none = convert fallará con error claro): se ve en el log del contenedor.
    from app.converters.office import ENGINE as office_engine
    print(f"[poller] office engine for convert: {office_engine}")
    conn = None
    while True:
        try:
            if conn is None or not conn.is_connected():
                conn = mysql.connector.connect(**settings.MYSQL_CONFIG)
                conn.autocommit = False
            job = claim_next_job(conn)
            if job is None:
                time.sleep(POLL_INTERVAL)
                continue
            process_job(conn, job)
        except mysql.connector.Error as e:
            print(f"[poller] DB error: {e}; reconnecting in {POLL_INTERVAL}s")
            try:
                if conn:
                    conn.close()
            except Exception:
                pass
            conn = None
            time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            print("[poller] shutting down")
            break


if __name__ == '__main__':
    main()
