"""Generación de formularios PDF rellenables (AcroForm) con reportlab.

Port del motor de `gestor-formularios-pdf` al patrón job/poller de ComprePDF.
A diferencia del resto de operaciones NO tiene archivo de entrada: el PDF se
genera desde la definición embebida en `operation_params.definition`.

La definición se organiza en secciones; cada sección tiene un título opcional y
un número de columnas, y cada pregunta ocupa 1..N de esas columnas
(`column_span`). Los payloads anteriores a las secciones (`questions` plano) se
envuelven en una sección implícita de una columna y se renderizan igual que
siempre.
"""
import base64
import io
import re
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, UnidentifiedImageError
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

from app.operations.common import custom_basename, output_path, parse_params, register_output

PAGE_SIZES = {'letter': LETTER, 'a4': A4}
_SLUG = re.compile(r'[^a-z0-9]+')
_DATA_URI = re.compile(r'^data:image/(png|jpeg);base64,(.+)$', re.DOTALL)

# Espejo de MAX_COLUMNS en backend/src/utils/form-definition.ts.
MAX_COLUMNS = 3

# Tope de pixeles al decodificar: el backend acota los BYTES, pero un PNG de
# pocos KB puede descomprimirse en una imagen gigantesca (bomba de descompresion).
MAX_IMAGE_PX = 4000

# Tipografía
LABEL_SIZE = 10
HELP_SIZE = 8
OPTION_SIZE = 9
SECTION_TITLE_SIZE = 11
FIELD_SIZE = 10

# Colores
NAVY = '#14213D'
INK = '#182230'
SUBTLE = '#536070'
MUTED = '#667085'
RULE = '#DCE1E7'
BORDER = '#98A2B3'
FIELD_INK = '#101828'
OPTION_INK = '#344054'
DANGER = '#B42318'

# Imágenes
LOGO_MAX_W = 45 * mm
LOGO_MAX_H = 14 * mm
LOGO_GAP_BELOW = 4 * mm
ICON_SIZE = 5 * mm
ICON_GAP = 2 * mm

# Layout
TITLE_SIZE = 16
GAP_AFTER_LABEL = 2 * mm
GAP_AFTER_HELP = 2 * mm
GAP_AFTER_FIELD = 7 * mm
LONG_TEXT_HEIGHT = 24 * mm
CHECKBOX_SIZE = 5 * mm
RADIO_SIZE = 4.5 * mm
RADIO_ROW = 7 * mm
# El bloque de opciones cierra con 5mm, no con los 7 del resto de campos.
RADIO_TRAILING = 5 * mm
OPTION_LABEL_X = 8 * mm
COLUMN_GUTTER = 6 * mm
SECTION_TITLE_GAP = 2 * mm
SECTION_RULE_GAP = 5 * mm


def _slug(name: str) -> str:
    """Nombre de archivo seguro a partir del nombre del formulario."""
    base = _SLUG.sub('-', (name or '').lower()).strip('-')
    return base or 'formulario'


def load_image(data_uri: Any) -> Optional[Image.Image]:
    """Decodifica un data URI de imagen. `None` si no hay o si no es válida.

    El backend ya valida y acota, pero el worker se defiende igual (mismo
    criterio que `sign.py`): al PDF solo llegan los píxeles decodificados, nunca
    los bytes originales, y una imagen rota nunca debe tumbar la generación —
    como mucho, sale el formulario sin ella.
    """
    if not isinstance(data_uri, str) or not data_uri:
        return None
    match = _DATA_URI.match(data_uri.strip())
    if not match:
        return None
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (ValueError, TypeError):
        return None
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            opened.load()
            image = opened.convert('RGBA')
    except Image.DecompressionBombError:
        return None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        return None
    if image.width > MAX_IMAGE_PX or image.height > MAX_IMAGE_PX:
        return None
    return image


def _fit(image: Image.Image, max_w: float, max_h: float) -> Tuple[float, float]:
    """Tamaño de dibujo que cabe en (max_w, max_h) conservando la proporción."""
    scale = min(max_w / image.width, max_h / image.height)
    return image.width * scale, image.height * scale


def sections_of(definition: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Secciones de la definición.

    Si `sections` viene, manda: el `questions` plano que la acompaña es un espejo
    derivado y leerlo además duplicaría el render. Si no viene, el payload es
    anterior a las secciones y lo envolvemos en una sección implícita sin título.
    """
    sections = definition.get('sections')
    if isinstance(sections, list) and sections:
        return sections
    return [{
        'title': '',
        'columns': 1,
        'page_break': False,
        'questions': definition.get('questions') or [],
    }]


def _clamp_columns(raw: Any) -> int:
    try:
        columns = int(raw)
    except (TypeError, ValueError):
        columns = 1
    return max(1, min(columns, MAX_COLUMNS))


def _clamp_span(raw: Any, columns: int) -> int:
    """El backend rechaza los spans fuera de rango con 400; aquí clampeamos para
    no reventar ante un payload antiguo o manipulado."""
    try:
        span = int(raw)
    except (TypeError, ValueError):
        span = 1
    return max(1, min(span, columns))


def pack_rows(questions: List[Dict[str, Any]], columns: int) -> List[List[Tuple[Dict[str, Any], int]]]:
    """Agrupa las preguntas en filas según su `column_span` (greedy).

    Devuelve `[[(pregunta, span), ...], ...]`. Una pregunta que no cabe en lo que
    queda de fila abre una nueva y deja el hueco vacío — igual que el
    `grid-auto-flow: row` del lienzo del editor. Función pura: se testea sin PDF.
    """
    rows: List[List[Tuple[Dict[str, Any], int]]] = []
    current: List[Tuple[Dict[str, Any], int]] = []
    used = 0
    for question in questions:
        span = _clamp_span(question.get('column_span'), columns)
        if used + span > columns and current:
            rows.append(current)
            current, used = [], 0
        current.append((question, span))
        used += span
        if used >= columns:
            rows.append(current)
            current, used = [], 0
    if current:
        rows.append(current)
    return rows


class PdfFormRenderer:
    """Dibuja un formulario AcroForm rellenable desde una definición (dict)."""

    margin_x = 18 * mm
    margin_top = 22 * mm
    margin_bottom = 20 * mm
    bottom_slack = 10 * mm
    field_height = 9 * mm

    def render(self, definition: Dict[str, Any]) -> bytes:
        header = definition.get('header') or {}
        footer = definition.get('footer') or {}
        page_size = PAGE_SIZES.get(str(definition.get('page_size', 'letter')).lower(), LETTER)

        output = io.BytesIO()
        pdf = canvas.Canvas(output, pagesize=page_size, pageCompression=1)
        pdf.setTitle(header.get('title') or definition.get('name') or 'Formulario')
        pdf.setAuthor('ComprePDF · Gestor de formularios')

        self.pdf = pdf
        self.form = pdf.acroForm
        self.header = header
        self.footer = footer
        # Se decodifica una vez: la cabecera se repite en cada página.
        self.logo = load_image(header.get('logo'))
        self._icon_cache: Dict[str, Optional[Image.Image]] = {}
        self.width, self.height = page_size
        self.page_number = 1
        self.y = self.height - self.margin_top
        self._draw_header()

        for section in sections_of(definition):
            self._draw_section(section)

        self._draw_footer()
        pdf.save()
        return output.getvalue()

    # ------------------------------------------------------------------ página

    def _draw_logo(self, title_baseline: float) -> Optional[float]:
        """Dibuja el logo arriba a la derecha. Devuelve la Y de su borde inferior.

        Se alinea por arriba con el título: `drawString` posiciona por la línea
        base, así que el borde superior del texto es la base + el ascendente.
        """
        if self.logo is None:
            return None
        width, height = _fit(self.logo, LOGO_MAX_W, LOGO_MAX_H)
        top = title_baseline + pdfmetrics.getAscent('Helvetica-Bold', TITLE_SIZE)
        x = self.width - self.margin_x - width
        self.pdf.drawImage(
            ImageReader(self.logo), x, top - height, width=width, height=height,
            mask='auto',   # respeta la transparencia del PNG
        )
        return top - height

    def _draw_header(self) -> None:
        title_baseline = self.y
        logo_bottom = self._draw_logo(title_baseline)

        self.pdf.setFillColor(colors.HexColor(NAVY))
        self.pdf.setFont('Helvetica-Bold', TITLE_SIZE)
        self.pdf.drawString(self.margin_x, self.y, self.header.get('title') or 'Formulario')
        self.y -= 7 * mm
        subtitle = self.header.get('subtitle')
        if subtitle:
            self.pdf.setFillColor(colors.HexColor(SUBTLE))
            self.pdf.setFont('Helvetica', 9)
            self.pdf.drawString(self.margin_x, self.y, subtitle)
            self.y -= 6 * mm

        # La regla va por debajo de todo: si el logo baja más que el texto, la
        # cruzaría por la mitad.
        if logo_bottom is not None:
            self.y = min(self.y, logo_bottom - LOGO_GAP_BELOW)

        self.pdf.setStrokeColor(colors.HexColor(RULE))
        self.pdf.line(self.margin_x, self.y, self.width - self.margin_x, self.y)
        self.y -= 8 * mm
        # Marca dónde empieza el cuerpo: sirve para saber si la página está
        # vacía y para calcular cuánto contenido cabe en una página.
        self.body_top = self.y

    def _draw_footer(self) -> None:
        y = 10 * mm
        self.pdf.setStrokeColor(colors.HexColor(RULE))
        self.pdf.line(self.margin_x, y + 5 * mm, self.width - self.margin_x, y + 5 * mm)
        self.pdf.setFillColor(colors.HexColor(MUTED))
        self.pdf.setFont('Helvetica', 8)
        if self.footer.get('text'):
            self.pdf.drawString(self.margin_x, y, self.footer['text'])
        if self.footer.get('show_page_numbers', True):
            self.pdf.drawRightString(self.width - self.margin_x, y, f'Página {self.page_number}')

    def _new_page(self) -> None:
        self._draw_footer()
        self.pdf.showPage()
        self.page_number += 1
        self.y = self.height - self.margin_top
        self._draw_header()

    def _page_is_empty(self) -> bool:
        return self.y == self.body_top

    def _page_capacity(self) -> float:
        """Alto útil de una página vacía."""
        return self.body_top - (self.margin_bottom + self.bottom_slack)

    def _ensure_space(self, height: float) -> None:
        """Salta de página si `height` no cabe en lo que queda.

        No salta si la página ya está vacía: el contenido no cabría tampoco en la
        siguiente y solo dejaría una hoja en blanco.
        """
        if self.y - height < self.margin_bottom + self.bottom_slack and not self._page_is_empty():
            self._new_page()

    # ------------------------------------------------------------------ anchos

    def _usable_width(self) -> float:
        return self.width - (2 * self.margin_x)

    def _column_width(self, columns: int) -> float:
        return (self._usable_width() - COLUMN_GUTTER * (columns - 1)) / columns

    def _span_width(self, span: int, columns: int) -> float:
        return span * self._column_width(columns) + COLUMN_GUTTER * (span - 1)

    def _column_x(self, taken: int, columns: int) -> float:
        return self.margin_x + taken * (self._column_width(columns) + COLUMN_GUTTER)

    # ------------------------------------------------------------------- texto

    def _para(self, text: str, size: int, color: str) -> Paragraph:
        style = ParagraphStyle(
            'question',
            fontName='Helvetica',
            fontSize=size,
            leading=size + 3,
            textColor=colors.HexColor(color),
            alignment=TA_LEFT,
        )
        return Paragraph(text, style)

    def _text_height(self, text: str, size: int, width: float, color: str = INK) -> float:
        _, height = self._para(text, size, color).wrap(width, 100 * mm)
        return height

    def _draw_text(self, text: str, x: float, y_top: float, width: float,
                   size: int, color: str = INK) -> float:
        """Dibuja el párrafo con su borde superior en `y_top` y devuelve su alto.

        No mueve `self.y`: quien llama decide si avanza el cursor. Mide con el
        mismo `wrap` que `_text_height`, así medida y dibujo no pueden discrepar.
        """
        paragraph = self._para(text, size, color)
        _, height = paragraph.wrap(width, 100 * mm)
        paragraph.drawOn(self.pdf, x, y_top - height)
        return height

    @staticmethod
    def _label_markup(question: Dict[str, Any]) -> str:
        """Etiqueta con su asterisco de requerido.

        Medir y dibujar tienen que usar este mismo string: el asterisco cambia el
        punto de corte de las líneas.
        """
        mark = f" <font color='{DANGER}'>*</font>" if question.get('required') else ''
        return f"<b>{question.get('label', '')}</b>{mark}"

    # ------------------------------------------------------------------ medida

    def _icon_of(self, question: Dict[str, Any]) -> Optional[Image.Image]:
        """Icono decodificado de la pregunta, cacheado.

        Medir y dibujar tienen que coincidir en si hay icono: si uno reservara el
        hueco y el otro no, la sangría descuadraría. Cachear la decodificación
        garantiza que ambos reciban la misma respuesta (y un icono corrupto es
        `None` en los dos).
        """
        uri = question.get('icon')
        if not isinstance(uri, str) or not uri:
            return None
        if uri not in self._icon_cache:
            self._icon_cache[uri] = load_image(uri)
        return self._icon_cache[uri]

    def _head_indent(self, question: Dict[str, Any]) -> float:
        """Sangría que deja el icono a la izquierda de la etiqueta."""
        return ICON_SIZE + ICON_GAP if self._icon_of(question) is not None else 0.0

    def _head_height(self, question: Dict[str, Any], width: float) -> float:
        """Alto de la etiqueta + el texto de ayuda (con su icono, si lo hay)."""
        indent = self._head_indent(question)
        text_width = width - indent
        height = self._text_height(self._label_markup(question), LABEL_SIZE, text_width)
        height += GAP_AFTER_LABEL
        if question.get('help_text'):
            height += self._text_height(question['help_text'], HELP_SIZE, text_width, MUTED)
            height += GAP_AFTER_HELP
        if indent:
            # Con una etiqueta de una línea el icono es más alto que el texto: el
            # campo no puede subirse por encima de él.
            height = max(height, ICON_SIZE + GAP_AFTER_LABEL)
        return height

    def _field_block_height(self, question: Dict[str, Any]) -> float:
        """Alto del control en sí, sin la etiqueta ni el hueco posterior."""
        qtype = str(question.get('type', 'short_text'))
        if qtype == 'long_text':
            return LONG_TEXT_HEIGHT
        if qtype == 'checkbox':
            return CHECKBOX_SIZE
        if qtype == 'radio':
            return len(question.get('options') or []) * RADIO_ROW
        return self.field_height

    @staticmethod
    def _trailing_gap(question: Dict[str, Any]) -> float:
        return RADIO_TRAILING if str(question.get('type')) == 'radio' else GAP_AFTER_FIELD

    def _measure_question(self, question: Dict[str, Any], width: float) -> float:
        """Alto exacto que consumirá `_draw_question` con ese ancho."""
        return (self._head_height(question, width)
                + self._field_block_height(question)
                + self._trailing_gap(question))

    def _row_metrics(self, row: List[Tuple[Dict[str, Any], int]], columns: int) -> Tuple[float, float]:
        """(alto de encabezado común, alto total) de una fila.

        Las etiquetas de una fila no miden lo mismo (una puede llevar texto de
        ayuda o partirse en dos líneas). Si cada celda colocara su control justo
        debajo de su propia etiqueta, las cajas de una misma fila quedarían a
        distinta altura. Reservamos el encabezado más alto para todas.
        """
        head = 0.0
        body = 0.0
        for question, span in row:
            width = self._span_width(span, columns)
            head = max(head, self._head_height(question, width))
            body = max(body, self._field_block_height(question) + self._trailing_gap(question))
        return head, head + body

    def _row_height(self, row: List[Tuple[Dict[str, Any], int]], columns: int) -> float:
        return self._row_metrics(row, columns)[1]

    # ----------------------------------------------------------------- dibujar

    def _draw_question_head(self, question: Dict[str, Any], x: float, y_top: float,
                            width: float) -> float:
        """Dibuja icono + etiqueta + ayuda. Devuelve la Y donde empieza el control.

        El icono va a la izquierda, alineado con la primera línea de la etiqueta;
        el texto se sangra a su derecha. El control de abajo NO se sangra: ocupa
        el ancho completo de la celda.
        """
        icon = self._icon_of(question)
        indent = ICON_SIZE + ICON_GAP if icon is not None else 0.0
        text_x = x + indent
        text_width = width - indent

        if icon is not None:
            icon_w, icon_h = _fit(icon, ICON_SIZE, ICON_SIZE)
            self.pdf.drawImage(ImageReader(icon), x, y_top - icon_h,
                               width=icon_w, height=icon_h, mask='auto')

        y = y_top - self._draw_text(self._label_markup(question), text_x, y_top,
                                    text_width, LABEL_SIZE)
        y -= GAP_AFTER_LABEL
        if question.get('help_text'):
            y -= self._draw_text(question['help_text'], text_x, y, text_width, HELP_SIZE, MUTED)
            y -= GAP_AFTER_HELP
        if indent:
            # Espejo del max() de _head_height: ambos deben dejar la misma Y.
            y = min(y, y_top - (ICON_SIZE + GAP_AFTER_LABEL))
        return y

    def _field_style(self, question: Dict[str, Any], x: float) -> Dict[str, Any]:
        return {
            'name': question.get('name', 'campo'),
            'x': x,
            'borderColor': colors.HexColor(BORDER),
            'fillColor': colors.white,
            'textColor': colors.HexColor(FIELD_INK),
            'forceBorder': True,
        }

    def _draw_radio_option(self, name: str, index: int, option: str,
                           x: float, y: float) -> float:
        self.form.radio(
            name=name,
            value=f'option_{index}',
            selected=False,
            x=x,
            y=y - 4 * mm,
            buttonStyle='circle',
            borderColor=colors.HexColor(BORDER),
            fillColor=colors.white,
            textColor=colors.HexColor(FIELD_INK),
            size=RADIO_SIZE,
            forceBorder=True,
        )
        self.pdf.setFont('Helvetica', OPTION_SIZE)
        self.pdf.setFillColor(colors.HexColor(OPTION_INK))
        self.pdf.drawString(x + OPTION_LABEL_X, y - 3 * mm, option)
        return y - RADIO_ROW

    def _draw_question(self, question: Dict[str, Any], x: float, width: float,
                       y_top: float, head_height: float = None) -> float:
        """Dibuja la pregunta en el rect (x, y_top, width) y devuelve el alto
        consumido.

        `head_height` reserva un alto fijo para la etiqueta en vez del suyo
        propio, para que los controles de una misma fila queden alineados.

        No toca `self.y` ni pagina: de eso se encargan `_draw_row` (que necesita
        que todas las celdas de una fila arranquen de la misma Y) y
        `_draw_flowing`.
        """
        qtype = str(question.get('type', 'short_text'))
        options: List[str] = list(question.get('options') or [])
        required = bool(question.get('required'))
        name = question.get('name', 'campo')

        y = self._draw_question_head(question, x, y_top, width)
        if head_height is not None:
            y = y_top - head_height
        flags = 'required' if required else ''
        common = self._field_style(question, x)

        if qtype in {'short_text', 'number', 'date'}:
            self.form.textfield(
                **common,
                y=y - self.field_height,
                width=width,
                height=self.field_height,
                fieldFlags=flags,
                fontName='Helvetica',
                fontSize=FIELD_SIZE,
            )
            y -= self.field_height
        elif qtype == 'select':
            self.form.choice(
                **common,
                y=y - self.field_height,
                width=width,
                height=self.field_height,
                options=options,
                value=options[0] if options else '',
                fieldFlags='combo required' if required else 'combo',
                fontName='Helvetica',
                fontSize=FIELD_SIZE,
            )
            y -= self.field_height
        elif qtype == 'long_text':
            self.form.textfield(
                **common,
                y=y - LONG_TEXT_HEIGHT,
                width=width,
                height=LONG_TEXT_HEIGHT,
                fieldFlags='multiline required' if required else 'multiline',
                fontName='Helvetica',
                fontSize=FIELD_SIZE,
            )
            y -= LONG_TEXT_HEIGHT
        elif qtype == 'checkbox':
            self.form.checkbox(
                **common,
                y=y - CHECKBOX_SIZE,
                size=CHECKBOX_SIZE,
                buttonStyle='check',
                checked=False,
                fieldFlags=flags,
            )
            self.pdf.setFont('Helvetica', OPTION_SIZE)
            self.pdf.setFillColor(colors.HexColor(OPTION_INK))
            self.pdf.drawString(x + OPTION_LABEL_X, y - 3.5 * mm, 'Sí')
            y -= CHECKBOX_SIZE
        elif qtype == 'radio':
            for index, option in enumerate(options):
                y = self._draw_radio_option(name, index, option, x, y)

        y -= self._trailing_gap(question)
        return y_top - y

    def _draw_flowing(self, question: Dict[str, Any], x: float, width: float) -> None:
        """Dibuja una pregunta que ocupa la fila entera, paginando si hace falta.

        Solo se usa para celdas a fila completa: partir una celda que tiene
        vecinas al lado la desalinearía. Muta `self.y`.
        """
        if str(question.get('type')) != 'radio':
            # Bloque indivisible: o cabe entero, o empieza en la página siguiente.
            self._ensure_space(self._measure_question(question, width))
            self.y -= self._draw_question(question, x, width, self.y)
            return

        # El bloque de opciones sí se puede partir: la etiqueta y la primera
        # opción van juntas, el resto continúa en la página siguiente.
        self._ensure_space(self._head_height(question, width) + RADIO_ROW)
        self.y = self._draw_question_head(question, x, self.y, width)
        name = question.get('name', 'campo')
        for index, option in enumerate(question.get('options') or []):
            self._ensure_space(RADIO_ROW)
            self.y = self._draw_radio_option(name, index, option, x, self.y)
        self.y -= RADIO_TRAILING

    def _draw_row(self, row: List[Tuple[Dict[str, Any], int]], columns: int) -> None:
        widths = [self._span_width(span, columns) for _, span in row]

        # Celda única: ocupa su fila entera, así que puede paginar por dentro.
        if len(row) == 1:
            self._draw_flowing(row[0][0], self.margin_x, widths[0])
            return

        head_height, row_height = self._row_metrics(row, columns)

        # Una fila con varias celdas más alta que la página no se puede partir sin
        # desalinearlas: se degrada a flujo vertical a ancho completo.
        if row_height > self._page_capacity():
            for question, _ in row:
                self._draw_flowing(question, self.margin_x, self._usable_width())
            return

        self._ensure_space(row_height)
        # Leer y_top DESPUÉS de _ensure_space: si saltó de página, la Y anterior
        # ya no existe y las celdas se dibujarían en la hoja equivocada.
        y_top = self.y
        taken = 0
        for (question, span), width in zip(row, widths):
            self._draw_question(question, self._column_x(taken, columns), width, y_top,
                                head_height=head_height)
            taken += span
        self.y = y_top - row_height

    def _draw_section_title(self, title: str, rows: List[List[Tuple[Dict[str, Any], int]]],
                            columns: int) -> None:
        markup = f'<b>{title}</b>'
        width = self._usable_width()
        head = self._text_height(markup, SECTION_TITLE_SIZE, width) + SECTION_TITLE_GAP + SECTION_RULE_GAP
        # Control de viudas: el título no puede quedarse solo al pie de página.
        first_row = self._row_height(rows[0], columns) if rows else 0
        self._ensure_space(head + first_row)

        self.y -= self._draw_text(markup, self.margin_x, self.y, width, SECTION_TITLE_SIZE, NAVY)
        self.y -= SECTION_TITLE_GAP
        self.pdf.setStrokeColor(colors.HexColor(RULE))
        self.pdf.line(self.margin_x, self.y, self.width - self.margin_x, self.y)
        self.y -= SECTION_RULE_GAP

    def _draw_section(self, section: Dict[str, Any]) -> None:
        columns = _clamp_columns(section.get('columns'))
        rows = pack_rows(section.get('questions') or [], columns)

        if section.get('page_break') and not self._page_is_empty():
            self._new_page()

        title = str(section.get('title') or '').strip()
        if title:
            self._draw_section_title(title, rows, columns)

        for row in rows:
            self._draw_row(row, columns)


def handle_form_generate(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Genera un PDF rellenable desde la definición del job (sin archivo de entrada)."""
    job_id = job['id']
    params = parse_params(job)
    definition = params.get('definition')
    if not isinstance(definition, dict):
        raise ValueError('form_generate job has no definition')

    pdf_bytes = PdfFormRenderer().render(definition)

    base = custom_basename(params) or _slug(definition.get('name', ''))
    path = output_path(job_id, f'{base}.pdf')
    path.write_bytes(pdf_bytes)

    register_output(cursor, job_id, path,
                    download_name=f'{base}.pdf',
                    mime_type='application/pdf')
    return {'questions': sum(len(s.get('questions') or []) for s in sections_of(definition))}
