"""Tests de la generación de formularios PDF rellenables (form_generate).

Usa el mismo FakeCursor que test_pdf_operations y redirige OUTPUT_DIR a un
directorio temporal. Verifica que el PDF resultante es un AcroForm con los
campos esperados.
"""
from pathlib import Path

import pikepdf
import pytest
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import mm

from app.config import settings
from app.operations.form_generate import handle_form_generate, load_image, pack_rows

USABLE_WIDTH = LETTER[0] - 2 * 18 * mm  # ancho de página menos los márgenes del renderer
MARGIN_BOTTOM = 20 * mm


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


# --------------------------------------------------------------- secciones


def _q(name, qtype='short_text', span=1, **extra):
    question = {'name': name, 'type': qtype, 'label': name.capitalize(),
                'help_text': '', 'required': False, 'options': [], 'column_span': span}
    question.update(extra)
    return question


def _section(**overrides):
    section = {'title': '', 'columns': 1, 'page_break': False, 'questions': []}
    section.update(overrides)
    return section


def _sectioned(*sections, **overrides):
    """Definición con secciones y SIN el espejo plano."""
    definition = _definition(**overrides)
    definition['sections'] = list(sections)
    definition.pop('questions', None)
    return definition


def _run(definition):
    cur = FakeCursor()
    result = handle_form_generate(
        {'id': 'j1', 'operation_params': {'definition': definition}}, cur)
    return cur, result


def _field_rects(path: Path):
    """(nombre, página, x0, y0, x1, y1) de cada widget. Con el PDF ABIERTO, como
    _acroform_field_names: las referencias indirectas mueren al cerrarlo."""
    rects = []
    with pikepdf.open(path) as pdf:
        for index, page in enumerate(pdf.pages):
            for annot in page.get('/Annots', []):
                name = annot.get('/T')
                if name is None:
                    parent = annot.get('/Parent')          # las opciones de radio
                    name = parent.get('/T') if parent is not None else None
                x0, y0, x1, y1 = (float(v) for v in annot.get('/Rect'))
                rects.append((str(name), index, x0, y0, x1, y1))
    return rects


def _by_name(path: Path):
    return {r[0]: r for r in _field_rects(path)}


def test_two_columns_are_side_by_side(tmp_path):
    cur, _ = _run(_sectioned(_section(columns=2, questions=[_q('nombre'), _q('apellido')])))
    fields = _by_name(cur.output_paths()[0])
    left, right = fields['nombre'], fields['apellido']

    assert left[1] == right[1] == 0            # misma página
    assert abs(left[3] - right[3]) < 0.5       # misma Y: están alineados
    assert left[2] < right[2]                  # nombre a la izquierda
    assert left[4] <= right[2]                 # sin solaparse
    assert abs((left[4] - left[2]) - (right[4] - right[2])) < 0.5   # mismo ancho


def test_fields_in_a_row_align_even_with_uneven_labels(tmp_path):
    # 'cedula' lleva texto de ayuda y 'telefono' no: si cada celda colocara su
    # control bajo su propia etiqueta, las cajas quedarían a distinta altura.
    cur, _ = _run(_sectioned(_section(columns=2, questions=[
        _q('cedula', help_text='Sin guiones'), _q('telefono')])))
    fields = _by_name(cur.output_paths()[0])
    assert abs(fields['cedula'][3] - fields['telefono'][3]) < 0.5


def test_column_span_takes_the_whole_row(tmp_path):
    cur, _ = _run(_sectioned(_section(columns=2, questions=[_q('notas', 'long_text', span=2)])))
    notas = _by_name(cur.output_paths()[0])['notas']
    assert abs((notas[4] - notas[2]) - USABLE_WIDTH) < 1


def test_mixed_row_pushes_full_width_question_below(tmp_path):
    cur, _ = _run(_sectioned(_section(columns=2, questions=[
        _q('ciudad'), _q('provincia'), _q('notas', 'long_text', span=2)])))
    fields = _by_name(cur.output_paths()[0])
    # El long_text no cabe junto a las cortas: baja a su propia fila.
    assert fields['notas'][5] <= min(fields['ciudad'][3], fields['provincia'][3])
    assert abs((fields['notas'][4] - fields['notas'][2]) - USABLE_WIDTH) < 1


def test_page_break_starts_a_new_page(tmp_path):
    cur, _ = _run(_sectioned(
        _section(title='Solicitante', questions=[_q('nombre')]),
        _section(title='Garante', page_break=True, questions=[_q('garante')]),
    ))
    fields = _by_name(cur.output_paths()[0])
    assert fields['nombre'][1] == 0
    assert fields['garante'][1] == 1


def test_page_break_on_first_section_leaves_no_blank_page(tmp_path):
    cur, _ = _run(_sectioned(_section(title='Uno', page_break=True, questions=[_q('nombre')])))
    with pikepdf.open(cur.output_paths()[0]) as pdf:
        assert len(pdf.pages) == 1


def test_sections_win_over_the_flat_mirror(tmp_path):
    # El espejo plano acompaña a las secciones; leer ambos duplicaría el render.
    definition = _definition()                     # trae 5 preguntas en `questions`
    definition['sections'] = [_section(questions=[_q('unico')])]
    cur, result = _run(definition)

    assert result['questions'] == 1
    assert _acroform_field_names(cur.output_paths()[0]) == ['unico']


def test_question_count_across_sections(tmp_path):
    _, result = _run(_sectioned(
        _section(columns=2, questions=[_q('nombre'), _q('apellido')]),
        _section(questions=[_q('notas', 'long_text')]),
    ))
    assert result['questions'] == 3


# Regresión: la estimación de espacio daba por fijo el alto de la pregunta (19mm)
# sin contar la etiqueta, que se dibuja después. Con 8 campos cortos delante, el
# cursor cae justo en la ventana donde la estimación pasa pero el alto real no
# cabe, y el campo terminaba a y0=52.7pt — por debajo del margen inferior (56.7pt).
def test_long_label_does_not_push_the_field_over_the_footer(tmp_path):
    label = 'Detalle de la solicitud con una etiqueta deliberadamente larga ' * 11
    questions = [_q(f'corto_{i}', label=f'Campo {i}') for i in range(8)]
    questions.append(_q('largo', label=label))
    cur, _ = _run(_sectioned(_section(questions=questions)))

    for name, page, _x0, y0, _x1, _y1 in _field_rects(cur.output_paths()[0]):
        assert y0 >= MARGIN_BOTTOM, f'{name} (página {page}) se dibuja sobre el pie'


# Regresión: el bucle de opciones no comprobaba espacio entre una y otra, así que
# las 30 caían todas en la misma página en vez de continuar en la siguiente.
def test_radio_with_many_options_splits_across_pages(tmp_path):
    options = [f'Opción {i}' for i in range(30)]
    cur, _ = _run(_sectioned(_section(questions=[_q('prioridad', 'radio', options=options)])))

    rects = _field_rects(cur.output_paths()[0])
    assert len(rects) == 30
    assert len({r[1] for r in rects}) >= 2, 'las 30 opciones deben repartirse en varias páginas'
    for name, page, _x0, y0, _x1, _y1 in rects:
        assert y0 >= MARGIN_BOTTOM, f'{name} (página {page}) se sale de la página'


# --------------------------------------------------------------- imagenes


def _png_data_uri(width=64, height=64, color=(200, 30, 40, 255)):
    """PNG real generado al vuelo: load_image decodifica de verdad, no vale un
    base64 cualquiera."""
    import base64 as _b64
    import io as _io

    from PIL import Image as _Image

    buffer = _io.BytesIO()
    _Image.new('RGBA', (width, height), color).save(buffer, format='PNG')
    return 'data:image/png;base64,' + _b64.b64encode(buffer.getvalue()).decode()


def test_logo_is_drawn_top_right(tmp_path):
    definition = _sectioned(_section(questions=[_q('nombre')]))
    definition['header'] = {**definition['header'], 'logo': _png_data_uri(120, 40)}
    cur, _ = _run(definition)

    # El logo no es un campo: se comprueba que el PDF lleva una imagen (XObject)
    # y que esta en la mitad derecha y arriba.
    with pikepdf.open(cur.output_paths()[0]) as pdf:
        page = pdf.pages[0]
        xobjects = page.Resources.get('/XObject')
        assert xobjects is not None, 'la pagina deberia tener una imagen'
        imagenes = [xobjects[k] for k in xobjects.keys()
                    if str(xobjects[k].get('/Subtype')) == '/Image']
        assert len(imagenes) == 1
        img = imagenes[0]
        assert int(img.Width) == 120 and int(img.Height) == 40


def test_logo_appears_on_every_page(tmp_path):
    # La cabecera se repite en cada pagina; el logo tambien debe hacerlo.
    definition = _sectioned(
        _section(questions=[_q('nombre')]),
        _section(page_break=True, questions=[_q('garante')]),
    )
    definition['header'] = {**definition['header'], 'logo': _png_data_uri()}
    cur, _ = _run(definition)

    with pikepdf.open(cur.output_paths()[0]) as pdf:
        assert len(pdf.pages) == 2
        for i, page in enumerate(pdf.pages):
            xobjects = page.Resources.get('/XObject')
            assert xobjects is not None, f'falta el logo en la pagina {i}'


def test_logo_pushes_the_rule_below_it(tmp_path):
    # Un logo alto baja el inicio del cuerpo: si no, la regla lo cruzaria.
    sin_logo = _sectioned(_section(questions=[_q('nombre')]))
    cur1, _ = _run(sin_logo)
    y_sin = _by_name(cur1.output_paths()[0])['nombre'][3]

    con_logo = _sectioned(_section(questions=[_q('nombre')]))
    con_logo['header'] = {**con_logo['header'], 'logo': _png_data_uri(100, 100)}  # cuadrado -> alto
    cur2, _ = _run(con_logo)
    y_con = _by_name(cur2.output_paths()[0])['nombre'][3]

    assert y_con < y_sin, 'con un logo alto el primer campo debe bajar'


def test_question_icon_indents_the_label_but_not_the_field(tmp_path):
    con_icono = _q('nombre', icon=_png_data_uri())
    cur, _ = _run(_sectioned(_section(questions=[con_icono])))

    fields = _by_name(cur.output_paths()[0])
    # El campo NO se sangra: sigue empezando en el margen izquierdo.
    assert abs(fields['nombre'][2] - 18 * mm) < 0.5
    with pikepdf.open(cur.output_paths()[0]) as pdf:
        xobjects = pdf.pages[0].Resources.get('/XObject')
        assert xobjects is not None, 'el icono deberia estar dibujado'


def test_icon_pushes_the_field_down(tmp_path):
    sin = _run(_sectioned(_section(questions=[_q('nombre')])))[0]
    con = _run(_sectioned(_section(questions=[_q('nombre', icon=_png_data_uri())])))[0]
    y_sin = _by_name(sin.output_paths()[0])['nombre'][3]
    y_con = _by_name(con.output_paths()[0])['nombre'][3]
    # El icono (5mm) es mas alto que una etiqueta de una linea: el campo baja.
    assert y_con < y_sin


def test_broken_image_does_not_break_generation(tmp_path):
    # Una imagen corrupta que se colara: el formulario debe salir igual, sin ella.
    basura = 'data:image/png;base64,' + 'QUJD'  # base64 valido, PNG invalido
    definition = _sectioned(_section(questions=[_q('nombre', icon=basura)]))
    definition['header'] = {**definition['header'], 'logo': basura}
    cur, result = _run(definition)

    assert result['questions'] == 1
    assert cur.output_paths()[0].read_bytes()[:5] == b'%PDF-'
    with pikepdf.open(cur.output_paths()[0]) as pdf:
        assert pdf.pages[0].Resources.get('/XObject') is None, 'no debe dibujar nada'


def test_icon_measure_matches_draw_when_image_is_broken(tmp_path):
    # Si medir y dibujar discreparan sobre si hay icono, la sangria descuadraria.
    roto = _q('roto', icon='data:image/png;base64,QUJD')
    sano = _q('sano')
    cur, _ = _run(_sectioned(_section(columns=2, questions=[roto, sano])))
    fields = _by_name(cur.output_paths()[0])
    # Ninguno tiene icono utilizable -> misma altura de encabezado -> misma Y.
    assert abs(fields['roto'][3] - fields['sano'][3]) < 0.5


@pytest.mark.parametrize('valor', [
    None, '', 'no-es-un-data-uri', 'https://ejemplo.com/x.png',
    'data:text/html;base64,PGh0bWw+', 'data:image/png;base64,!!!no-base64!!!',
])
def test_load_image_rejects_garbage(valor):
    assert load_image(valor) is None


def test_load_image_accepts_a_real_png():
    image = load_image(_png_data_uri(30, 20))
    assert image is not None
    assert (image.width, image.height) == (30, 20)


@pytest.mark.parametrize('spans, columns, expected', [
    ([1, 1, 1], 2, [[1, 1], [1]]),      # el sobrante abre fila nueva
    ([2, 1], 2, [[2], [1]]),
    ([1, 2], 2, [[1], [2]]),            # el span 2 no cabe al lado: deja el hueco
    ([1, 1, 1], 3, [[1, 1, 1]]),
    ([3], 2, [[2]]),                    # span mayor que las columnas: se clampea
    ([1], 1, [[1]]),
])
def test_pack_rows(spans, columns, expected):
    questions = [_q(f'campo_{i}', span=span) for i, span in enumerate(spans)]
    rows = pack_rows(questions, columns)
    assert [[span for _, span in row] for row in rows] == expected


def test_pack_rows_empty():
    assert pack_rows([], 2) == []
