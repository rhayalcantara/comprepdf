"""Test del handler de emisión (app/operations/certificate.py).

Verifica el cableado completo sin base de datos real: genera una CA temporal,
llama al handler con un cursor falso y comprueba que escribe el .pfx, registra el
output y la fila de auditoría, y destruye la contraseña del .pfx.
"""
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.serialization import pkcs12

from app.ca import root_ca
from app.config import settings
from app.operations.certificate import handle_certificate

CA_PWD = 'ca-passphrase-de-prueba'
PFX_PWD = 'clave-del-empleado'


class FakeCursor:
    """Captura INSERT/UPDATE distinguiendo por tabla."""

    def __init__(self):
        self.file_inserts = []
        self.cert_inserts = []
        self.updates = []

    def execute(self, sql, params=None):
        s = ' '.join(sql.split()).upper()
        if s.startswith('INSERT INTO FILES'):
            self.file_inserts.append(params)
        elif s.startswith('INSERT INTO CERTIFICADOS_EMITIDOS'):
            self.cert_inserts.append(params)
        elif s.startswith('UPDATE'):
            self.updates.append((s, params))

    def fetchall(self):
        return []

    def fetchone(self):
        return None


@pytest.fixture(autouse=True)
def _ca_and_output(tmp_path, monkeypatch):
    ca_dir = tmp_path / 'ca'
    root_ca.generate_root_ca(
        ca_dir=str(ca_dir), password=CA_PWD,
        common_name='Coopaspire CA', org='Coopaspire', country='DO',
        validity_years=15,
    )
    monkeypatch.setattr(settings, 'CA_DIR', str(ca_dir))
    monkeypatch.setattr(settings, 'CA_KEY_PASSWORD', CA_PWD)
    monkeypatch.setattr(settings, 'OUTPUT_DIR', str(tmp_path / 'out'))
    yield


def _job(**params):
    base = {
        'nombre': 'María Gómez',
        'cedula': '002-7654321-0',
        'email': 'mgomez@coopaspire.com.do',
        'departamento': 'Contabilidad',
        'pfx_password': PFX_PWD,
        'emitido_por': 'admin',
    }
    base.update(params)
    return {'id': 'job-cert-1', 'operation_params': base}


def test_handler_emite_y_registra():
    cur = FakeCursor()
    result = handle_certificate(_job(), cur)

    assert result == {'files_output': 1}

    # Se registró un archivo de salida .pfx y existe en disco.
    assert len(cur.file_inserts) == 1
    out_path = Path(cur.file_inserts[0][4])
    assert out_path.exists() and out_path.suffix == '.pfx'

    # El .pfx se abre con la contraseña del empleado y contiene la hoja.
    key, leaf, cas = pkcs12.load_key_and_certificates(out_path.read_bytes(), PFX_PWD.encode())
    assert leaf is not None

    # Se anotó en certificados_emitidos con el mismo serial que el cert.
    assert len(cur.cert_inserts) == 1
    serial_registrado = cur.cert_inserts[0][0]
    assert serial_registrado == format(leaf.serial_number, 'x')
    assert cur.cert_inserts[0][2] == 'María Gómez'  # empleado_nombre

    # Se destruyó la contraseña del .pfx (UPDATE ... JSON_REMOVE pfx_password).
    assert any('JSON_REMOVE' in s and 'PFX_PASSWORD' in s for s, _ in cur.updates)


def test_handler_falla_sin_nombre():
    cur = FakeCursor()
    with pytest.raises(ValueError):
        handle_certificate(_job(nombre=''), cur)


def test_handler_falla_sin_password():
    cur = FakeCursor()
    with pytest.raises(ValueError):
        handle_certificate(_job(pfx_password=''), cur)
