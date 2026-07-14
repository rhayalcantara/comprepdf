"""Tests de las operaciones PDF (pikepdf) usando un cursor MySQL falso.

No requiere una base de datos: se simula el acceso a `files` con FakeCursor y se
redirige OUTPUT_DIR a un directorio temporal.
"""
import io
import zipfile
from pathlib import Path

import pikepdf
import pytest

from app.config import settings
from app.operations import pdf_ops
from app.operations.sign import handle_sign


# --- utilidades ---

class FakeCursor:
    """Cursor mínimo: devuelve los originales en fetchall y captura INSERT/UPDATE."""

    def __init__(self, originals):
        self.originals = originals
        self.inserts = []
        self.updates = []

    def execute(self, sql, params=None):
        s = sql.strip().upper()
        if s.startswith('INSERT'):
            self.inserts.append(params)
        elif s.startswith('UPDATE'):
            self.updates.append(params)

    def fetchall(self):
        return list(self.originals)

    def fetchone(self):
        return self.originals[0] if self.originals else None

    def output_paths(self):
        # register_output inserta: (id, job_id, name, download_name, str(path), size, mime)
        return [Path(p[4]) for p in self.inserts]


def make_pdf(path: Path, pages: int) -> None:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)


@pytest.fixture(autouse=True)
def _output_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'OUTPUT_DIR', str(tmp_path / 'out'))
    yield


def _original(path: Path, name: str = 'doc.pdf', fid: str = 'f1'):
    return {'id': fid, 'file_path': str(path), 'original_filename': name, 'filename': path.name}


# --- tests ---

def test_split_individual(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 10)
    cur = FakeCursor([_original(src)])
    result = pdf_ops.handle_split({'id': 'j1', 'operation_params': {'mode': 'individual'}}, cur)

    assert result['files_output'] == 10
    zip_path = cur.output_paths()[0]
    with zipfile.ZipFile(zip_path) as zf:
        assert len(zf.namelist()) == 10


def test_split_ranges(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 10)
    cur = FakeCursor([_original(src)])
    params = {'mode': 'ranges', 'ranges': ['1-3', '5']}
    result = pdf_ops.handle_split({'id': 'j1', 'operation_params': params}, cur)

    assert result['files_output'] == 2
    with zipfile.ZipFile(cur.output_paths()[0]) as zf:
        names = zf.namelist()
        assert len(names) == 2
        # el primer rango (1-3) debe tener 3 páginas
        first = pikepdf.open(io.BytesIO(zf.read(names[0])))
        assert len(first.pages) == 3


def test_merge(tmp_path):
    a, b = tmp_path / 'a.pdf', tmp_path / 'b.pdf'
    make_pdf(a, 3)
    make_pdf(b, 4)
    cur = FakeCursor([_original(a, 'a.pdf', 'fa'), _original(b, 'b.pdf', 'fb')])
    params = {'file_order': ['fa', 'fb']}
    result = pdf_ops.handle_merge({'id': 'j1', 'operation_params': params}, cur)

    assert result['files_output'] == 1
    merged = pikepdf.open(cur.output_paths()[0])
    assert len(merged.pages) == 7


def test_extract(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 10)
    cur = FakeCursor([_original(src)])
    result = pdf_ops.handle_extract({'id': 'j1', 'operation_params': {'pages': '2-4,8'}}, cur)

    assert result['pages_extracted'] == 4
    out = pikepdf.open(cur.output_paths()[0])
    assert len(out.pages) == 4


def test_rotate(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 3)
    cur = FakeCursor([_original(src)])
    result = pdf_ops.handle_rotate({'id': 'j1', 'operation_params': {'degrees': 90, 'pages': 'all'}}, cur)

    assert result['degrees'] == 90
    out = pikepdf.open(cur.output_paths()[0])
    for page in out.pages:
        assert int(page.get('/Rotate', 0)) == 90


def test_protect_and_unlock(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 2)

    # proteger
    cur = FakeCursor([_original(src)])
    pdf_ops.handle_protect({'id': 'j1', 'operation_params': {'password': 'secret'}}, cur)
    protected = cur.output_paths()[0]

    # abrir sin contraseña debe fallar
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(protected)

    # desbloquear con la contraseña correcta
    cur2 = FakeCursor([_original(protected, 'protected.pdf')])
    pdf_ops.handle_unlock({'id': 'j2', 'operation_params': {'password': 'secret'}}, cur2)
    unlocked = cur2.output_paths()[0]
    opened = pikepdf.open(unlocked)  # ya no requiere contraseña
    assert len(opened.pages) == 2


def test_unlock_wrong_password(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 1)
    cur = FakeCursor([_original(src)])
    pdf_ops.handle_protect({'id': 'j1', 'operation_params': {'password': 'right'}}, cur)
    protected = cur.output_paths()[0]

    cur2 = FakeCursor([_original(protected)])
    with pytest.raises(ValueError):
        pdf_ops.handle_unlock({'id': 'j2', 'operation_params': {'password': 'wrong'}}, cur2)


def test_merge_custom_output_name(tmp_path):
    a, b = tmp_path / 'a.pdf', tmp_path / 'b.pdf'
    make_pdf(a, 1)
    make_pdf(b, 1)
    cur = FakeCursor([_original(a, 'a.pdf', 'fa'), _original(b, 'b.pdf', 'fb')])
    params = {'file_order': ['fa', 'fb'], 'output_name': 'acta: comité.pdf'}
    pdf_ops.handle_merge({'id': 'j1', 'operation_params': params}, cur)

    # download_name es el 4º valor del INSERT; saneado y con extensión única
    assert cur.inserts[0][3] == 'acta comité.pdf'


def test_split_custom_output_name(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 4)
    cur = FakeCursor([_original(src)])
    params = {'mode': 'ranges', 'ranges': ['1-2', '3-4'], 'output_name': 'expediente'}
    pdf_ops.handle_split({'id': 'j1', 'operation_params': params}, cur)

    assert cur.inserts[0][3] == 'expediente.zip'
    with zipfile.ZipFile(cur.output_paths()[0]) as zf:
        assert sorted(zf.namelist()) == ['expediente_1-2.pdf', 'expediente_3-4.pdf']


def test_output_name_empty_falls_back_to_default(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 3)
    cur = FakeCursor([_original(src)])
    # Tras sanear ('///' no deja nada) debe usarse el nombre por defecto
    params = {'pages': '1-2', 'output_name': '///'}
    pdf_ops.handle_extract({'id': 'j1', 'operation_params': params}, cur)

    assert cur.inserts[0][3] == 'doc_extracted.pdf'


def test_sign_missing_cert(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 1)
    cur = FakeCursor([_original(src)])
    with pytest.raises(ValueError):
        handle_sign({'id': 'j1', 'operation_params': {'cert_path': str(tmp_path / 'nope.pfx')}}, cur)
