"""Tests de la generación de formularios PDF rellenables (form_generate).

Usa el mismo FakeCursor que test_pdf_operations y redirige OUTPUT_DIR a un
directorio temporal. Verifica que el PDF resultante es un AcroForm con los
campos esperados.
"""
from pathlib import Path

import pikepdf
import pytest

from app.config import settings
from app.operations.form_generate import handle_form_generate


class FakeCursor:
    """Cursor mínimo: captura los INSERT de register_output."""

    def __init__(self):
        self.inserts = []

    def execute(self, sql, params=None):
        if sql.strip().upper().startswith('INSERT'):
            self.inserts.append(params)

    def output_paths(self):
        return [Path(p[4]) for p in self.inserts]


@pytest.fixture(autouse=True)
def _output_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'OUTPUT_DIR', str(tmp_path / 'out'))
    yield


def _definition(**overrides):
    definition = {
        'name': 'Solicitud de servicio',
        'description': '',
        'page_size': 'letter',
        'header': {'title': 'Solicitud de servicio', 'subtitle': 'Complete los campos'},
        'footer': {'text': 'Uso interno', 'show_page_numbers': True},
        'questions': [
            {'name': 'nombre', 'type': 'short_text', 'label': 'Nombre completo',
             'help_text': '', 'required': True, 'options': []},
            {'name': 'comentario', 'type': 'long_text', 'label': 'Comentarios',
             'help_text': 'Opcional', 'required': False, 'options': []},
            {'name': 'acepta', 'type': 'checkbox', 'label': 'Acepto los términos',
             'help_text': '', 'required': True, 'options': []},
            {'name': 'prioridad', 'type': 'radio', 'label': 'Prioridad',
             'help_text': '', 'required': False, 'options': ['Normal', 'Urgente']},
            {'name': 'sucursal', 'type': 'select', 'label': 'Sucursal',
             'help_text': '', 'required': False, 'options': ['Centro', 'Norte', 'Sur']},
        ],
    }
    definition.update(overrides)
    return definition


def _acroform_field_names(path: Path):
    """Nombres (/T) de los campos de nivel superior. Se leen con el PDF ABIERTO:
    devolver las referencias indirectas tras cerrar el archivo las invalida."""
    with pikepdf.open(path) as pdf:
        root = pdf.Root
        assert '/AcroForm' in root, 'el PDF debería tener AcroForm'
        fields = list(root.AcroForm.Fields)
        return [str(f.get('/T')) for f in fields]


def test_generates_acroform_with_all_fields(tmp_path):
    cur = FakeCursor()
    result = handle_form_generate(
        {'id': 'j1', 'operation_params': {'definition': _definition()}}, cur)

    assert result['questions'] == 5
    out = cur.output_paths()[0]
    assert out.exists()
    # 5 preguntas → 5 campos de nivel superior (radio agrupa sus opciones).
    names = _acroform_field_names(out)
    assert len(names) == 5
    assert set(names) == {'nombre', 'comentario', 'acepta', 'prioridad', 'sucursal'}


def test_valid_pdf_magic_bytes(tmp_path):
    cur = FakeCursor()
    handle_form_generate({'id': 'j1', 'operation_params': {'definition': _definition()}}, cur)
    data = cur.output_paths()[0].read_bytes()
    assert data[:5] == b'%PDF-'


def test_download_name_from_form_name(tmp_path):
    cur = FakeCursor()
    handle_form_generate({'id': 'j1', 'operation_params': {'definition': _definition()}}, cur)
    # download_name es el 4º valor del INSERT (slug del nombre).
    assert cur.inserts[0][3] == 'solicitud-de-servicio.pdf'


def test_custom_output_name(tmp_path):
    cur = FakeCursor()
    params = {'definition': _definition(), 'output_name': 'formato: nómina'}
    handle_form_generate({'id': 'j1', 'operation_params': params}, cur)
    assert cur.inserts[0][3] == 'formato nómina.pdf'


def test_empty_questions_still_generates(tmp_path):
    cur = FakeCursor()
    result = handle_form_generate(
        {'id': 'j1', 'operation_params': {'definition': _definition(questions=[])}}, cur)
    assert result['questions'] == 0
    assert cur.output_paths()[0].read_bytes()[:5] == b'%PDF-'


def test_a4_page_size(tmp_path):
    cur = FakeCursor()
    handle_form_generate(
        {'id': 'j1', 'operation_params': {'definition': _definition(page_size='a4')}}, cur)
    pdf = pikepdf.open(cur.output_paths()[0])
    # A4 ≈ 595 x 842 pt; Letter ≈ 612 x 792. Distinguimos por el alto.
    box = pdf.pages[0].MediaBox
    height = float(box[3]) - float(box[1])
    assert 835 < height < 848


def test_missing_definition_raises(tmp_path):
    cur = FakeCursor()
    with pytest.raises(ValueError):
        handle_form_generate({'id': 'j1', 'operation_params': {}}, cur)
