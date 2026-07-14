"""Tests de la generación y carga de la CA raíz interna (Fase 1).

No requiere base de datos: opera sobre un directorio temporal.
"""
from datetime import datetime, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtensionOID, NameOID

from app.ca import root_ca


PWD = 'passphrase-de-prueba-larga'


def _generate(tmp_path, **overrides):
    kwargs = dict(
        ca_dir=str(tmp_path),
        password=PWD,
        common_name='Coopaspire CA',
        org='Coopaspire',
        country='DO',
        validity_years=15,
    )
    kwargs.update(overrides)
    return root_ca.generate_root_ca(**kwargs)


def test_genera_archivos(tmp_path):
    key_file, cert_pem, cert_der = _generate(tmp_path)
    assert key_file.exists() and cert_pem.exists() and cert_der.exists()


def test_es_ca_con_basic_constraints(tmp_path):
    _, cert_pem, _ = _generate(tmp_path)
    cert = x509.load_pem_x509_certificate(cert_pem.read_bytes())

    bc = cert.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS)
    assert bc.critical is True
    assert bc.value.ca is True
    assert bc.value.path_length == 0


def test_key_usage_correcto(tmp_path):
    _, cert_pem, _ = _generate(tmp_path)
    cert = x509.load_pem_x509_certificate(cert_pem.read_bytes())

    ku = cert.extensions.get_extension_for_oid(ExtensionOID.KEY_USAGE).value
    assert ku.key_cert_sign is True
    assert ku.crl_sign is True
    assert ku.digital_signature is False


def test_autofirmado_y_atributos(tmp_path):
    _, cert_pem, _ = _generate(tmp_path)
    cert = x509.load_pem_x509_certificate(cert_pem.read_bytes())

    # Subject == issuer (autofirmado).
    assert cert.subject == cert.issuer
    cn = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    assert cn == 'Coopaspire CA'
    # Vigente ahora y con vencimiento futuro.
    assert cert.not_valid_after_utc > datetime.now(timezone.utc)


def test_clave_esta_cifrada_falla_con_password_incorrecta(tmp_path):
    _generate(tmp_path)
    # Password correcta: recarga bien.
    key, cert = root_ca.load_root_ca(str(tmp_path), PWD)
    assert isinstance(key, rsa.RSAPrivateKey)
    assert cert.subject == cert.issuer
    # Password incorrecta: debe fallar.
    with pytest.raises(Exception):
        root_ca.load_root_ca(str(tmp_path), 'password-incorrecta')


def test_no_sobrescribe_sin_overwrite(tmp_path):
    _generate(tmp_path)
    with pytest.raises(FileExistsError):
        _generate(tmp_path)
    # Con overwrite=True sí se puede regenerar.
    key_file, _, _ = _generate(tmp_path, overwrite=True)
    assert key_file.exists()


def test_password_vacia_es_rechazada(tmp_path):
    with pytest.raises(ValueError):
        _generate(tmp_path, password='')


def test_country_invalido_se_omite(tmp_path):
    _, cert_pem, _ = _generate(tmp_path, country='DOM')
    cert = x509.load_pem_x509_certificate(cert_pem.read_bytes())
    assert cert.subject.get_attributes_for_oid(NameOID.COUNTRY_NAME) == []
