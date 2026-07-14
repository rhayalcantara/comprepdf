"""Emisión de un certificado personal (.pfx) firmado por la CA interna.

Handler del job `certificate`. No recibe archivo original: los datos del empleado
llegan en operation_params. Carga la CA (cuya clave privada vive solo en el
worker), emite el .pfx, lo registra como archivo de salida y anota el certificado
en `certificados_emitidos` para auditoría.

Seguridad: la contraseña del .pfx viaja en operation_params y se usa una sola
vez; se destruye inmediatamente después (igual que en la firma con .pfx). Nunca
se registra en logs.
"""
import datetime as _dt
from typing import Any, Dict

from app.ca.leaf import EmployeeInfo, issue_certificate
from app.ca.root_ca import load_root_ca
from app.config import settings
from app.operations.common import (
    custom_basename,
    output_path,
    parse_params,
    register_output,
)

# Caracteres seguros para el nombre del archivo .pfx.
import re as _re

_SAFE = _re.compile(r'[^A-Za-z0-9._-]+')


def handle_certificate(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    job_id = job['id']
    params = parse_params(job)

    nombre = (params.get('nombre') or '').strip()
    if not nombre:
        raise ValueError("Falta el nombre del empleado")

    pfx_password = params.get('pfx_password') or ''
    if not pfx_password:
        raise ValueError("Falta la contraseña del .pfx")

    employee = EmployeeInfo(
        nombre=nombre,
        cedula=(params.get('cedula') or None),
        email=(params.get('email') or None),
        departamento=(params.get('departamento') or None),
    )
    validity_years = params.get('validity_years')

    try:
        # Cargar la CA raíz (falla cerrado si no está configurada/generada).
        ca_key, ca_cert = load_root_ca(settings.CA_DIR, settings.CA_KEY_PASSWORD)

        issued = issue_certificate(
            ca_key=ca_key,
            ca_cert=ca_cert,
            employee=employee,
            pfx_password=pfx_password,
            validity_years=validity_years,
        )

        # Nombre de archivo amigable: <nombre>[_<cedula>].pfx
        base = custom_basename(params) or _SAFE.sub('_', nombre).strip('_') or 'certificado'
        if employee.cedula:
            base = f"{base}_{_SAFE.sub('', employee.cedula)}"
        out_name = f"{base}.pfx"
        out_path = output_path(job_id, out_name)
        out_path.write_bytes(issued.pfx_bytes)

        register_output(
            cursor,
            job_id,
            out_path,
            download_name=out_name,
            mime_type='application/x-pkcs12',
        )

        _register_certificate(cursor, job_id, issued, employee, params.get('emitido_por'))
    finally:
        _destroy_password(cursor, job_id)

    return {'files_output': 1}


def _register_certificate(cursor, job_id, issued, employee: EmployeeInfo, emitido_por) -> None:
    """Anota el certificado emitido en certificados_emitidos (auditoría)."""
    cursor.execute(
        """
        INSERT INTO certificados_emitidos
            (serial, job_id, empleado_nombre, empleado_cedula, empleado_email,
             departamento, not_before, not_after, estado, emitido_por)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'activo', %s)
        """,
        (
            issued.serial_hex,
            job_id,
            employee.nombre,
            employee.cedula,
            employee.email,
            employee.departamento,
            issued.not_before.astimezone(_dt.timezone.utc).replace(tzinfo=None),
            issued.not_after.astimezone(_dt.timezone.utc).replace(tzinfo=None),
            emitido_por or 'admin',
        ),
    )


def _destroy_password(cursor, job_id: str) -> None:
    """Elimina la contraseña del .pfx de operation_params tras usarla."""
    try:
        cursor.execute(
            """
            UPDATE compression_jobs
            SET operation_params = JSON_REMOVE(operation_params, '$.pfx_password')
            WHERE id = %s
            """,
            (job_id,),
        )
    except Exception:
        pass
