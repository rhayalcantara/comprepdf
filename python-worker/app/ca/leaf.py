"""Emisión de certificados personales (hoja) firmados por la CA interna.

Genera un par de claves + certificado para un empleado, firmado por la
"Coopaspire CA" (ver `root_ca.py`), y lo empaqueta en un PKCS#12 (.pfx)
protegido con la contraseña que elija el empleado.

El .pfx incluye la cadena (cert del empleado + cert de la CA) para que los
validadores puedan construir la ruta de confianza hasta la raíz.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

_LEAF_KEY_SIZE = 2048
_DEFAULT_VALIDITY_YEARS = 2


@dataclass
class EmployeeInfo:
    nombre: str
    cedula: Optional[str] = None
    email: Optional[str] = None
    departamento: Optional[str] = None


@dataclass
class IssuedCertificate:
    pfx_bytes: bytes
    serial_hex: str
    not_before: datetime
    not_after: datetime


def issue_certificate(
    ca_key,
    ca_cert: x509.Certificate,
    employee: EmployeeInfo,
    pfx_password: str,
    validity_years: Optional[int] = None,
) -> IssuedCertificate:
    """Emite un certificado personal firmado por la CA y lo devuelve como .pfx.

    Falla si no hay contraseña para el .pfx o si el empleado no tiene nombre.
    """
    if not employee.nombre or not employee.nombre.strip():
        raise ValueError("El nombre del empleado es obligatorio")
    if not pfx_password:
        raise ValueError("Se requiere una contraseña para proteger el .pfx")

    years = validity_years or _DEFAULT_VALIDITY_YEARS

    # 1) Par de claves del empleado.
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=_LEAF_KEY_SIZE)

    # 2) Subject a partir de los datos del empleado.
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, employee.nombre.strip())]
    if employee.email:
        attrs.append(x509.NameAttribute(NameOID.EMAIL_ADDRESS, employee.email.strip()))
    if employee.departamento:
        attrs.append(
            x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, employee.departamento.strip())
        )
    if employee.cedula:
        # La cédula como serialNumber del subject (identificador estable).
        attrs.append(x509.NameAttribute(NameOID.SERIAL_NUMBER, employee.cedula.strip()))
    # Heredar organización/país de la CA para coherencia visual.
    for oid in (NameOID.ORGANIZATION_NAME, NameOID.COUNTRY_NAME):
        vals = ca_cert.subject.get_attributes_for_oid(oid)
        if vals:
            attrs.append(x509.NameAttribute(oid, vals[0].value))
    subject = x509.Name(attrs)

    now = datetime.now(timezone.utc)
    not_before = now - timedelta(minutes=5)
    not_after = now + timedelta(days=365 * years)

    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        # Hoja, no puede actuar como CA.
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        # Para firma de documentos: firma digital + no repudio.
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,  # nonRepudiation
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.EMAIL_PROTECTION]),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(leaf_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()),
            critical=False,
        )
    )

    # SAN con el correo (los validadores modernos exigen SAN, no solo el subject).
    if employee.email:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.RFC822Name(employee.email.strip())]),
            critical=False,
        )

    leaf_cert = builder.sign(private_key=ca_key, algorithm=hashes.SHA256())

    # 3) Empaquetar PKCS#12 (.pfx) con la cadena y cifrado con la contraseña.
    friendly = employee.nombre.strip().encode('utf-8')
    pfx_bytes = pkcs12.serialize_key_and_certificates(
        name=friendly,
        key=leaf_key,
        cert=leaf_cert,
        cas=[ca_cert],
        encryption_algorithm=serialization.BestAvailableEncryption(
            pfx_password.encode('utf-8')
        ),
    )

    return IssuedCertificate(
        pfx_bytes=pfx_bytes,
        serial_hex=format(leaf_cert.serial_number, 'x'),
        not_before=not_before,
        not_after=not_after,
    )
