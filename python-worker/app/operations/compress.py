"""Handler de compresión (refactorizado desde compression_worker.py)."""
import time
from pathlib import Path
from typing import Any, Dict

from app.config import settings
from app.compression.ghostscript import GhostscriptCompressor
from app.compression.pdf_analyzer import PdfAnalyzer
from app.operations.common import custom_basename, get_single_original, parse_params, register_output

compressor = GhostscriptCompressor()
analyzer = PdfAnalyzer()


def handle_compress(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    start_time = time.time()
    job_id = job['id']

    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    custom = custom_basename(parse_params(job))
    download_name = f"{custom}.pdf" if custom else original['original_filename']
    output_filename = f"compressed_{original['original_filename']}"
    out_path = Path(settings.OUTPUT_DIR) / output_filename
    out_path.parent.mkdir(parents=True, exist_ok=True)

    pdf_info = analyzer.analyze(input_path)
    if pdf_info.get('is_encrypted'):
        raise Exception("Cannot compress encrypted PDF")

    result = compressor.compress(
        input_path=input_path,
        output_path=out_path,
        level=job.get('compression_level') or 'medium',
        custom_dpi=job.get('custom_dpi'),
    )

    processing_time = int((time.time() - start_time) * 1000)
    compression_ratio = round(
        (1 - result['compressed_size'] / result['original_size']) * 100, 2
    )

    register_output(cursor, job_id, out_path,
                    download_name=download_name,
                    mime_type='application/pdf')

    cursor.execute(
        """
        INSERT INTO compression_stats
        (job_id, original_size, compressed_size, compression_ratio, processing_time_ms,
         pages_count, images_count)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (job_id, result['original_size'], result['compressed_size'],
         compression_ratio, processing_time,
         pdf_info.get('pages_count'), pdf_info.get('images_count')),
    )

    return {'compression_ratio': compression_ratio, 'files_output': 1}
