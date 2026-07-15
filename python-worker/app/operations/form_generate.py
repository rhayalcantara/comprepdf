"""Generación de formularios PDF rellenables (AcroForm) con reportlab.

Port del motor de `gestor-formularios-pdf` al patrón job/poller de ComprePDF.
A diferencia del resto de operaciones NO tiene archivo de entrada: el PDF se
genera desde la definición embebida en `operation_params.definition`.
"""
import io
import re
from pathlib import Path
from typing import Any, Dict, List

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

from app.operations.common import custom_basename, output_path, parse_params, register_output

PAGE_SIZES = {'letter': LETTER, 'a4': A4}
OPTION_TYPES = {'radio', 'select'}
_SLUG = re.compile(r'[^a-z0-9]+')


def _slug(name: str) -> str:
    """Nombre de archivo seguro a partir del nombre del formulario."""
    base = _SLUG.sub('-', (name or '').lower()).strip('-')
    return base or 'formulario'


class PdfFormRenderer:
    """Dibuja un formulario AcroForm rellenable desde una definición (dict)."""

    margin_x = 18 * mm
    margin_top = 22 * mm
    margin_bottom = 20 * mm
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
        self.width, self.height = page_size
        self.page_number = 1
        self.y = self.height - self.margin_top
        self._draw_header()

        for question in definition.get('questions') or []:
            self._draw_question(question)

        self._draw_footer()
        pdf.save()
        return output.getvalue()

    def _draw_header(self) -> None:
        self.pdf.setFillColor(colors.HexColor('#14213D'))
        self.pdf.setFont('Helvetica-Bold', 16)
        self.pdf.drawString(self.margin_x, self.y, self.header.get('title') or 'Formulario')
        self.y -= 7 * mm
        subtitle = self.header.get('subtitle')
        if subtitle:
            self.pdf.setFillColor(colors.HexColor('#536070'))
            self.pdf.setFont('Helvetica', 9)
            self.pdf.drawString(self.margin_x, self.y, subtitle)
            self.y -= 6 * mm
        self.pdf.setStrokeColor(colors.HexColor('#DCE1E7'))
        self.pdf.line(self.margin_x, self.y, self.width - self.margin_x, self.y)
        self.y -= 8 * mm

    def _draw_footer(self) -> None:
        y = 10 * mm
        self.pdf.setStrokeColor(colors.HexColor('#DCE1E7'))
        self.pdf.line(self.margin_x, y + 5 * mm, self.width - self.margin_x, y + 5 * mm)
        self.pdf.setFillColor(colors.HexColor('#667085'))
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

    def _ensure_space(self, height: float) -> None:
        if self.y - height < self.margin_bottom + 10 * mm:
            self._new_page()

    def _paragraph(self, text: str, size: int = 10, color: str = '#182230') -> float:
        style = ParagraphStyle(
            'question',
            fontName='Helvetica',
            fontSize=size,
            leading=size + 3,
            textColor=colors.HexColor(color),
            alignment=TA_LEFT,
        )
        paragraph = Paragraph(text, style)
        available = self.width - (2 * self.margin_x)
        _, height = paragraph.wrap(available, 100 * mm)
        paragraph.drawOn(self.pdf, self.margin_x, self.y - height)
        self.y -= height
        return height

    def _draw_question(self, question: Dict[str, Any]) -> None:
        qtype = str(question.get('type', 'short_text'))
        options: List[str] = list(question.get('options') or [])
        required = bool(question.get('required'))

        option_height = len(options) * 7 * mm if qtype == 'radio' else 0
        base_height = 29 * mm if qtype == 'long_text' else 19 * mm
        self._ensure_space(base_height + option_height)

        required_mark = " <font color='#B42318'>*</font>" if required else ''
        self._paragraph(f"<b>{question.get('label', '')}</b>{required_mark}", 10)
        self.y -= 2 * mm
        if question.get('help_text'):
            self._paragraph(question['help_text'], 8, '#667085')
            self.y -= 2 * mm

        field_width = self.width - (2 * self.margin_x)
        flags = 'required' if required else ''
        name = question.get('name', 'campo')
        common = {
            'name': name,
            'x': self.margin_x,
            'borderColor': colors.HexColor('#98A2B3'),
            'fillColor': colors.white,
            'textColor': colors.HexColor('#101828'),
            'forceBorder': True,
        }

        if qtype in {'short_text', 'number', 'date'}:
            self.form.textfield(
                **common,
                y=self.y - self.field_height,
                width=field_width,
                height=self.field_height,
                fieldFlags=flags,
                fontName='Helvetica',
                fontSize=10,
            )
            self.y -= self.field_height + 7 * mm
        elif qtype == 'select':
            self.form.choice(
                **common,
                y=self.y - self.field_height,
                width=field_width,
                height=self.field_height,
                options=options,
                value=options[0] if options else '',
                fieldFlags='combo required' if required else 'combo',
                fontName='Helvetica',
                fontSize=10,
            )
            self.y -= self.field_height + 7 * mm
        elif qtype == 'long_text':
            height = 24 * mm
            multiline_flags = 'multiline required' if required else 'multiline'
            self.form.textfield(
                **common,
                y=self.y - height,
                width=field_width,
                height=height,
                fieldFlags=multiline_flags,
                fontName='Helvetica',
                fontSize=10,
            )
            self.y -= height + 7 * mm
        elif qtype == 'checkbox':
            self.form.checkbox(
                **common,
                y=self.y - 5 * mm,
                size=5 * mm,
                buttonStyle='check',
                checked=False,
                fieldFlags=flags,
            )
            self.pdf.setFont('Helvetica', 9)
            self.pdf.setFillColor(colors.HexColor('#344054'))
            self.pdf.drawString(self.margin_x + 8 * mm, self.y - 3.5 * mm, 'Sí')
            self.y -= 12 * mm
        elif qtype == 'radio':
            for index, option in enumerate(options):
                self.form.radio(
                    name=name,
                    value=f'option_{index}',
                    selected=False,
                    x=self.margin_x,
                    y=self.y - 4 * mm,
                    buttonStyle='circle',
                    borderColor=colors.HexColor('#98A2B3'),
                    fillColor=colors.white,
                    textColor=colors.HexColor('#101828'),
                    size=4.5 * mm,
                    forceBorder=True,
                )
                self.pdf.setFont('Helvetica', 9)
                self.pdf.setFillColor(colors.HexColor('#344054'))
                self.pdf.drawString(self.margin_x + 8 * mm, self.y - 3 * mm, option)
                self.y -= 7 * mm
            self.y -= 5 * mm


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
    return {'questions': len(definition.get('questions') or [])}
