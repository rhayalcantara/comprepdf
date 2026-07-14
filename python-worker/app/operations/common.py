"""Utilidades compartidas por los handlers de operaciones PDF.

Cada handler recibe el `job` (dict con los campos de compression_jobs) y un cursor
de MySQL ya abierto por el poller. El poller se encarga de las transiciones de
estado (processing/completed/failed); los handlers solo hacen el trabajo y
registran los archivos de salida en la tabla `files`.
"""
import json
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings

# Caracteres no válidos en nombres de archivo (Windows es el más restrictivo)
_INVALID_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def parse_params(job: Dict[str, Any]) -> Dict[str, Any]:
    """Devuelve operation_params como dict (la columna JSON puede llegar como str)."""
    raw = job.get('operation_params')
    if raw is None:
        return {}
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode('utf-8')
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return {}


def get_original_files(cursor, job_id: str, file_order: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Obtiene los archivos originales de un job.

    Si se pasa `file_order` (lista de file ids), respeta ese orden; de lo
    contrario ordena por fecha de creación.
    """
    cursor.execute(
        """
        SELECT id, file_path, original_filename, filename
        FROM files
        WHERE job_id = %s AND file_type = 'original'
        ORDER BY created_at ASC
        """,
        (job_id,),
    )
    rows = cursor.fetchall()
    if file_order:
        index = {fid: i for i, fid in enumerate(file_order)}
        rows.sort(key=lambda r: index.get(r['id'], len(index)))
    return rows


def get_single_original(cursor, job_id: str) -> Dict[str, Any]:
    """Obtiene el único archivo original de un job (compress/split/sign/...)."""
    rows = get_original_files(cursor, job_id)
    if not rows:
        raise ValueError(f"Job {job_id} has no original file")
    return rows[0]


def output_path(job_id: str, filename: str) -> Path:
    """Ruta de salida única en el volumen compartido OUTPUT_DIR."""
    out_dir = Path(settings.OUTPUT_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    unique = f"{uuid.uuid4().hex}_{filename}"
    return out_dir / unique


def register_output(
    cursor,
    job_id: str,
    path: Path,
    download_name: str,
    mime_type: str = 'application/pdf',
) -> str:
    """Inserta una fila `files` de tipo 'output' y devuelve su id.

    `download_name` es el nombre amigable que verá el usuario al descargar.
    """
    file_id = str(uuid.uuid4())
    cursor.execute(
        """
        INSERT INTO files (id, job_id, file_type, filename, original_filename,
                           file_path, file_size, mime_type, expires_at)
        VALUES (%s, %s, 'output', %s, %s, %s, %s, %s,
                DATE_ADD(NOW(), INTERVAL 24 HOUR))
        """,
        (
            file_id,
            job_id,
            path.name,
            download_name,
            str(path),
            path.stat().st_size,
            mime_type,
        ),
    )
    return file_id


def stem(filename: str) -> str:
    """Nombre base sin extensión (para construir nombres de salida)."""
    return Path(filename).stem


def custom_basename(params: Dict[str, Any]) -> Optional[str]:
    """Nombre de salida elegido por el usuario (`output_name`), saneado, o None.

    El backend ya sanea el valor; esto es defensa en profundidad porque el
    worker es quien construye el nombre final. Quita caracteres inválidos para
    nombres de archivo, la extensión (.pdf/.zip) si el usuario la escribió, y
    limita la longitud.
    """
    raw = params.get('output_name')
    if not isinstance(raw, str):
        return None
    name = _INVALID_NAME_CHARS.sub('', raw).strip()
    if name.lower().endswith(('.pdf', '.zip')):
        name = name[:name.rfind('.')]
    name = name.strip().strip('.')
    return name[:100].strip() or None


def parse_page_list(value: Any, page_count: int, strict: bool = False) -> List[int]:
    """Normaliza una especificación de páginas a índices 0-based válidos.

    Acepta:
      - lista de enteros 1-based: [1, 3, 5]
      - lista de rangos como str: ["1-3", "5"]
      - str con comas: "1-3,5,8-10"

    Con `strict=False` (por defecto) las páginas fuera de rango se ignoran en
    silencio (comportamiento histórico de extract/rotate/split). Con
    `strict=True` cualquier página fuera de rango levanta ValueError.
    """
    pages: List[int] = []

    def add(n: int):
        idx = n - 1
        if 0 <= idx < page_count:
            if idx not in pages:
                pages.append(idx)
        elif strict:
            raise ValueError(
                f"Page {n} is out of range (document has {page_count} pages)"
            )

    tokens: List[str] = []
    if isinstance(value, str):
        tokens = [t.strip() for t in value.split(',') if t.strip()]
    elif isinstance(value, list):
        for item in value:
            tokens.append(str(item).strip())
    else:
        raise ValueError("Invalid page specification")

    for token in tokens:
        if '-' in token:
            start_s, end_s = token.split('-', 1)
            start, end = int(start_s), int(end_s)
            if start > end:
                start, end = end, start
            for n in range(start, end + 1):
                add(n)
        else:
            add(int(token))

    if not pages:
        raise ValueError("No valid pages in selection")
    return pages
