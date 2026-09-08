"""Traducción de PDF manteniendo el diseño — PyMuPDF + LLM local (Ollama).

Por cada página se extraen los bloques de texto (bbox + tamaño y color de
fuente), se traducen en lote contra el Ollama del worker y se reescriben en su
misma posición: una anotación de redacción borra el texto original (sin tocar
imágenes) y `insert_textbox` escribe la traducción en el mismo recuadro,
reduciendo el tamaño de fuente si la traducción es más larga que el original.

Solo idiomas de alfabeto latino: la escritura usa la fuente base 'helv'
(Latin-1), que no cubre CJK/árabe/cirílico.
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF (dependencia de pdf2docx)
import requests

from app.config import settings
from app.converters.pdf_word import assert_pdf_extractable

SUPPORTED_LANGS = {
    'es': 'Spanish',
    'en': 'English',
    'fr': 'French',
    'pt': 'Portuguese',
    'it': 'Italian',
    'de': 'German',
}

OLLAMA_UNAVAILABLE = (
    'The translation server is not available; try again later or contact the administrator'
)

MIN_FONT_SIZE = 6.0
# Lotes acotados: con demasiados segmentos por petición el LLM pierde la
# alineación 1:1 entrada/salida con más frecuencia (visto en QA con un
# whitepaper denso el 2026-07-22).
MAX_SEGMENTS_PER_REQUEST = 25

# El LLM debe devolver exactamente una traducción por segmento, en orden.
_RESPONSE_SCHEMA = {
    'type': 'object',
    'properties': {
        'translations': {'type': 'array', 'items': {'type': 'string'}},
    },
    'required': ['translations'],
}

# 'helv' es Latin-1: la puntuación tipográfica que suelen emitir los LLM se
# normaliza a su equivalente ASCII para no acabar en '?'.
_UNICODE_FALLBACKS = str.maketrans({
    '‘': "'", '’': "'", '“': '"', '”': '"',
    '–': '-', '—': '-', '…': '...', ' ': ' ',
})


def translate_pdf(input_path: Path, output_path: Path, target_lang: str) -> None:
    """Traduce un PDF a `target_lang`. Lanza ValueError con mensaje claro si no se puede."""
    language = SUPPORTED_LANGS.get(target_lang)
    if language is None:
        raise ValueError(f'Unsupported target language: {target_lang}')

    assert_pdf_extractable(input_path)

    doc = fitz.open(str(input_path))
    try:
        for page in doc:
            _translate_page(page, language)
        doc.save(str(output_path), garbage=3, deflate=True)
    finally:
        doc.close()

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise ValueError('Translation produced no output')


def _translate_page(page: 'fitz.Page', language: str) -> None:
    blocks = _text_blocks(page)
    if not blocks:
        return

    translations = _translate_segments([b['text'] for b in blocks], language)

    # Primero borrar TODOS los originales (las redacciones se aplican en una
    # pasada) y después escribir las traducciones en los mismos recuadros.
    for block in blocks:
        page.add_redact_annot(block['bbox'])
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    for block, translated in zip(blocks, translations):
        text = translated.translate(_UNICODE_FALLBACKS).strip()
        if text:
            _insert_text(page, block['bbox'], text, block['size'], block['color'])


def _text_blocks(page: 'fitz.Page') -> List[Dict[str, Any]]:
    """Bloques de texto traducibles de la página: texto plano, bbox y la fuente
    (tamaño/color) del primer span como representativa del bloque.

    Los bloques sin ninguna letra (números de página, cifras sueltas) se dejan
    intactos: no hay nada que traducir y conservan su fuente original.
    """
    blocks: List[Dict[str, Any]] = []
    for raw in page.get_text('dict')['blocks']:
        if raw.get('type') != 0:  # 1 = imagen
            continue
        spans = [s for line in raw.get('lines', []) for s in line.get('spans', [])]
        text = ' '.join(s['text'] for s in spans).strip()
        if not text or not any(c.isalpha() for c in text):
            continue
        blocks.append({
            'text': text,
            'bbox': fitz.Rect(raw['bbox']),
            'size': spans[0].get('size', 11.0),
            'color': _srgb_to_rgb(spans[0].get('color', 0)),
        })
    return blocks


def _srgb_to_rgb(value: int) -> Tuple[float, float, float]:
    return ((value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255)


def _insert_text(page: 'fitz.Page', rect: 'fitz.Rect', text: str,
                 fontsize: float, color: Tuple[float, float, float]) -> None:
    """Escribe `text` dentro de `rect` reduciendo la fuente hasta que quepa.

    `insert_textbox` no escribe nada y devuelve negativo si el texto no cabe;
    como último recurso se extiende el recuadro hasta el pie de página.
    """
    # Bloques muy estrechos (etiquetas de casillas, celdas): sin ancho para la
    # palabra más larga, insert_textbox parte en una letra por línea. Se
    # ensancha lo mínimo, con tope en el borde de la página.
    longest = max(text.split(), key=len, default='')
    needed = fitz.get_text_length(longest, fontname='helv', fontsize=MIN_FONT_SIZE) + 2
    if longest and rect.width < needed:
        rect = fitz.Rect(rect.x0, rect.y0, min(rect.x0 + needed, page.rect.x1), rect.y1)

    size = max(fontsize, MIN_FONT_SIZE)
    while size >= MIN_FONT_SIZE:
        if page.insert_textbox(rect, text, fontname='helv', fontsize=size, color=color) >= 0:
            return
        size -= 0.5
    fallback = fitz.Rect(rect.x0, rect.y0, rect.x1, page.rect.y1)
    page.insert_textbox(fallback, text, fontname='helv', fontsize=MIN_FONT_SIZE, color=color)


# --- Cliente Ollama ---

def _translate_segments(segments: List[str], language: str) -> List[str]:
    """Traduce los segmentos por lotes conservando la alineación 1:1."""
    out: List[str] = []
    for start in range(0, len(segments), MAX_SEGMENTS_PER_REQUEST):
        out.extend(_translate_batch(segments[start:start + MAX_SEGMENTS_PER_REQUEST], language))
    return out


def _translate_batch(segments: List[str], language: str) -> List[str]:
    # Un reintento: los LLM a veces devuelven más/menos elementos que la entrada.
    for attempt in (1, 2):
        translations = _chat(segments, language)
        if len(translations) == len(segments):
            return translations
    # Degradación: segmento a segmento. Más lento (una petición por bloque)
    # pero la alineación queda garantizada; convierte el fallo duro que se vio
    # en QA en un éxito lento.
    return [_translate_single(s, language) for s in segments]


def _translate_single(segment: str, language: str) -> str:
    for attempt in (1, 2):
        translations = _chat([segment], language)
        if len(translations) >= 1 and translations[0].strip():
            return translations[0]
    # Último recurso: conservar el texto original de ESTE bloque en vez de
    # tumbar el job entero. (Si Ollama está caído, _post_chat ya lanzó antes.)
    return segment


def _chat(segments: List[str], language: str) -> List[str]:
    payload = {
        'model': settings.OLLAMA_MODEL,
        'stream': False,
        'format': _RESPONSE_SCHEMA,
        'options': {'temperature': 0},
        # Sin razonamiento: en modelos "thinking" acelera mucho la traducción.
        'think': False,
        'messages': [
            {
                'role': 'system',
                'content': (
                    f'You are a professional translator. Translate each input segment into {language}. '
                    'Return ONLY JSON with a "translations" array containing exactly one translated '
                    'string per input segment, in the same order. Preserve numbers, dates, codes, '
                    'acronyms, emails and proper names as they are. Do not add explanations.'
                ),
            },
            {'role': 'user', 'content': json.dumps({'segments': segments}, ensure_ascii=False)},
        ],
    }
    response = _post_chat(payload)
    try:
        content = response.json()['message']['content']
        translations = json.loads(content)['translations']
    except (ValueError, KeyError, TypeError):
        return []  # respuesta malformada: cuenta como intento fallido del lote
    if not isinstance(translations, list):
        return []
    return [str(t) for t in translations]


def _post_chat(payload: Dict[str, Any]) -> 'requests.Response':
    url = f"{settings.OLLAMA_URL.rstrip('/')}/api/chat"
    try:
        response = requests.post(url, json=payload, timeout=settings.OLLAMA_TIMEOUT)
        if response.status_code == 400 and 'think' in payload:
            # Modelos sin capacidad "thinking" rechazan el parámetro.
            retry = {k: v for k, v in payload.items() if k != 'think'}
            response = requests.post(url, json=retry, timeout=settings.OLLAMA_TIMEOUT)
        response.raise_for_status()
        return response
    except requests.RequestException:
        raise ValueError(OLLAMA_UNAVAILABLE)
