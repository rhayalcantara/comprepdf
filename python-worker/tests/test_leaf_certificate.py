"""Tests de emisión de certificados personales (Fase 2).

Cubre: emisión de la hoja firmada por la CA, empaquetado .pfx, verificación
criptográfica de la cadena, y usabilidad del .pfx con pyHanko (tarea 2.5).
"""
from datetime import datetime, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtensionOID, NameOID

from app.ca import root_ca
from app.ca.leaf import EmployeeInfo, issue_certificate

CA_PWD = 'ca-passphrase-de-prueba'
PFX_PWD = 'clave-del-empleado'


@pytest.fixture
def ca(tmp_path):
    root_ca.generate_root_ca(
        ca_dir=str(tmp_path), password=CA_PWD,
        common_name='Coopaspire CA', org='Coopaspire', country='DO',
        validity_years=15,
    )
    return root_ca.load_root_ca(str(tmp_path), CA_PWD)


def _employee():
    return EmployeeInfo(
        nombre='Juan Pérez',
        cedula='001-1234567-8',
        email='jperez@coopaspire.com.do',
        departamento='Tecnología',
    )


def test_emite_pfx_y_serial(ca):
    ca_key, ca_cert = ca
    issued = issue_certificate(ca_key, ca_cert, _employee(), PFX_PWD)
    assert issued.pfx_bytes and len(issued.pfx_bytes) > 100
    assert int(issued.serial_hex, 16) > 0
    assert issued.not_after > datetime.now(timezone.utc)


def test_cadena_firmada_por_la_ca(ca):
    ca_key, ca_cert = ca
    issued = issue_certificate(ca_key, ca_cert, _employee(), PFX_PWD)

    key, leaf, cas = pkcs12.load_key_and_certificates(
        issued.pfx_bytes, PFX_PWD.encode('utf-8')
    )
    # El issuer de la hoja es el subject de la CA.
    assert leaf.issuer == ca_cert.subject
    # La cadena incluye la CA para construir la ruta de confianza.
    assert any(c.subject == ca_cert.subject for c in cas)
    # Verificación criptográfica: la CA firmó la hoja.
    ca_cert.public_key().verify(
        leaf.signature,
        leaf.tbs_certificate_bytes,
        padding.PKCS1v15(),
        leaf.signature_hash_algorithm,
    )


def test_atributos_y_extensiones(ca):
    ca_key, ca_cert = ca
    issued = issue_certificate(ca_key, ca_cert, _employee(), PFX_PWD)
    _, leaf, _ = pkcs12.load_key_and_certificates(issued.pfx_bytes, PFX_PWD.encode('utf-8'))

    assert leaf.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == 'Juan Pérez'
    assert leaf.subject.get_attributes_for_oid(NameOID.EMAIL_ADDRESS)[0].value == 'jperez@coopaspire.com.do'
    assert leaf.subject.get_attributes_for_oid(NameOID.SERIAL_NUMBER)[0].value == '001-1234567-8'

    # No es CA.
    bc = leaf.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS).value
    assert bc.ca is False
    # Firma digital + no repudio.
    ku = leaf.extensions.get_extension_for_oid(ExtensionOID.KEY_USAGE).value
    assert ku.digital_signature is True
    assert ku.content_commitment is True
    assert ku.key_cert_sign is False
    # SAN con el correo.
    san = leaf.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
    assert 'jperez@coopaspire.com.do' in san.get_values_for_type(x509.RFC822Name)


def test_pfx_falla_con_password_incorrecta(ca):
    ca_key, ca_cert = ca
    issued = issue_certificate(ca_key, ca_cert, _employee(), PFX_PWD)
    with pytest.raises(Exception):
        pkcs12.load_key_and_certificates(issued.pfx_bytes, b'password-incorrecta')


def test_validity_years_configurable(ca):
    ca_key, ca_cert = ca
    issued = issue_certificate(ca_key, ca_cert, _employee(), PFX_PWD, validity_years=1)
    dias = (issued.not_after - issued.not_before).days
    assert 360 <= dias <= 370


def test_requiere_nombre_y_password(ca):
    ca_key, ca_cert = ca
    with pytest.raises(ValueError):
        issue_certificate(ca_key, ca_cert, EmployeeInfo(nombre=''), PFX_PWD)
    with pytest.raises(ValueError):
        issue_certificate(ca_key, ca_cert, _employee(), '')


def test_pfx_cargable_por_pyhanko(ca):
    """Tarea 2.5 (parte 1): el .pfx sirve como firmante en pyHanko."""
    ca_key, ca_cert = ca
    issued = issue_certificate(ca_key, ca_cert, _employee(), PFX_PWD)

    import io
    from pyhanko.sign import signers

    signer = signers.SimpleSigner.load_pkcs12_data(
        issued.pfx_bytes, [], passphrase=PFX_PWD.encode('utf-8'),
    )
    assert signer is not None
    assert signer.signing_cert is not None


def test_firma_pdf_valida_contra_la_raiz(ca, tmp_path):
    """Tarea 2.5 (parte 2): un PDF firmado con el .pfx emitido establece
    confianza cuando la CA raíz está en el ancla de confianza."""
    import io

    import pikepdf
    from pyhanko.sign import signers
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext
    from pyhanko_certvalidator.registry import SimpleCertificateStore
    from asn1crypto import x509 as asn1_x509

    ca_key, ca_cert = ca
    issued = issue_certificate(ca_key, ca_cert, _employee(), PFX_PWD)

    # PDF mínimo.
    src = tmp_path / 'in.pdf'
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(src)

    signer = signers.SimpleSigner.load_pkcs12_data(
        issued.pfx_bytes, [], passphrase=PFX_PWD.encode('utf-8'),
    )

    signed = io.BytesIO()
    with open(src, 'rb') as inf:
        writer = IncrementalPdfFileWriter(inf)
        signers.sign_pdf(
            writer,
            signers.PdfSignatureMetadata(field_name='Signature1'),
            signer=signer,
            output=signed,
        )

    # Ancla de confianza = la CA raíz (como harían las PCs tras la Fase 5).
    ca_asn1 = asn1_x509.Certificate.load(ca_cert.public_bytes(
        __import__('cryptography').hazmat.primitives.serialization.Encoding.DER
    ))
    vc = ValidationContext(
        trust_roots=[ca_asn1],
        allow_fetching=False,
        revocation_mode='soft-fail',
    )

    signed.seek(0)
    from pyhanko.pdf_utils.reader import PdfFileReader
    r = PdfFileReader(signed)
    sig = r.embedded_signatures[0]
    status = validate_pdf_signature(sig, signer_validation_context=vc)

    assert status.intact is True   # el contenido no se alteró
    assert status.valid is True    # la firma es criptográficamente válida
    assert status.trusted is True  # encadena hasta la CA raíz de confianza
