"""CA raíz interna de la cooperativa ("Coopaspire CA").

Este módulo genera y custodia el ancla de confianza del módulo de certificados:
un par de claves + certificado raíz autofirmado que se crea UNA sola vez y con
el que después se firman los certificados personales de los empleados (Fase 2).

Seguridad:
- La clave privada raíz se guarda cifrada con una passphrase (`CA_KEY_PASSWORD`)
  que vive fuera del repo (variable de entorno / secreto).
- Los archivos se escriben en `CA_DIR`, que está en .gitignore.
- Es el activo más sensible del sistema: quien tenga la clave puede emitir
  certificados a nombre de cualquiera. Por eso `generate_root_ca` se niega a
  sobrescribir una CA existente salvo que se pida explícitamente.
"""
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

# Nombres de archivo dentro de CA_DIR.
KEY_FILENAME = 'ca-key.pem'   # clave privada raíz, cifrada (PEM/PKCS8)
CERT_PEM_FILENAME = 'ca-cert.pem'  # certificado raíz en PEM
CERT_DER_FILENAME = 'ca-cert.cer'  # certificado raíz en DER (para importar en Windows)

_KEY_SIZE = 4096


def _build_name(common_name: str, org: str, country: str) -> x509.Name:
    attrs = [
        x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, org),
    ]
    # C debe ser un código de país de 2 letras; si viene mal, se omite.
    if country and len(country) == 2:
        attrs.append(x509.NameAttribute(NameOID.COUNTRY_NAME, country.upper()))
    return x509.Name(attrs)


def generate_root_ca(
    ca_dir: str,
    password: str,
    common_name: str,
    org: str,
    country: str,
    validity_years: int,
    overwrite: bool = False,
) -> Tuple[Path, Path, Path]:
    """Genera la CA raíz autofirmada y la escribe en `ca_dir`.

    Devuelve las rutas (clave, cert PEM, cert DER).

    Falla cerrado: exige `password`, y se niega a sobrescribir una clave raíz
    existente salvo `overwrite=True` (re-generarla invalidaría todos los
    certificados ya emitidos y obligaría a re-distribuir el ancla de confianza).
    """
    if not password:
        raise ValueError(
            "CA_KEY_PASSWORD no está configurada: no se puede cifrar la clave raíz."
        )

    ca_path = Path(ca_dir)
    ca_path.mkdir(parents=True, exist_ok=True)

    key_file = ca_path / KEY_FILENAME
    cert_pem_file = ca_path / CERT_PEM_FILENAME
    cert_der_file = ca_path / CERT_DER_FILENAME

    if key_file.exists() and not overwrite:
        raise FileExistsError(
            f"Ya existe una clave raíz en {key_file}. Sobrescribirla invalidaría "
            f"los certificados emitidos. Usa overwrite=True solo si estás seguro."
        )

    # 1) Par de claves RSA 4096.
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=_KEY_SIZE)

    # 2) Certificado raíz autofirmado (subject == issuer).
    name = _build_name(common_name, org, country)
    now = datetime.now(timezone.utc)
    # Pequeño desfase hacia atrás para tolerar relojes desincronizados.
    not_before = now - timedelta(minutes=5)
    not_after = now + timedelta(days=365 * validity_years)

    public_key = private_key.public_key()
    ski = x509.SubjectKeyIdentifier.from_public_key(public_key)

    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        # Es una CA que puede firmar certificados hoja pero no sub-CAs.
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(ski, critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(public_key),
            critical=False,
        )
        .sign(private_key=private_key, algorithm=hashes.SHA256())
    )

    # 3) Escribir la clave privada CIFRADA (PKCS8/PEM).
    key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.BestAvailableEncryption(
            password.encode('utf-8')
        ),
    )
    _write_private(key_file, key_pem)

    # 4) Escribir el certificado público (PEM y DER).
    cert_pem_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    cert_der_file.write_bytes(cert.public_bytes(serialization.Encoding.DER))

    return key_file, cert_pem_file, cert_der_file


def load_root_ca(ca_dir: str, password: str):
    """Carga la clave privada y el certificado raíz para firmar (Fase 2).

    Devuelve (private_key, certificate). Lanza si falta la passphrase, no
    existen los archivos, o la passphrase es incorrecta.
    """
    if not password:
        raise ValueError("CA_KEY_PASSWORD no está configurada: no se puede cargar la CA.")

    ca_path = Path(ca_dir)
    key_file = ca_path / KEY_FILENAME
    cert_pem_file = ca_path / CERT_PEM_FILENAME

    if not key_file.exists() or not cert_pem_file.exists():
        raise FileNotFoundError(
            f"No se encontró la CA en {ca_dir}. Genérala con "
            f"'python -m app.ca.generate_root_ca'."
        )

    private_key = serialization.load_pem_private_key(
        key_file.read_bytes(), password=password.encode('utf-8')
    )
    cert = x509.load_pem_x509_certificate(cert_pem_file.read_bytes())
    return private_key, cert


def _write_private(path: Path, data: bytes) -> None:
    """Escribe un archivo con permisos restrictivos (best-effort en Windows)."""
    path.write_bytes(data)
    try:
        # 0o600: solo el dueño lee/escribe. En Windows chmod tiene efecto limitado;
        # la protección real de la clave se apoya en ACLs del sistema + la
        # passphrase de cifrado.
        os.chmod(path, 0o600)
    except OSError:
        pass
