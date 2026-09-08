"""CLI de generación única de la CA raíz.

Uso (desde python-worker/, con CA_KEY_PASSWORD en el entorno):

    python -m app.ca.generate_root_ca
    python -m app.ca.generate_root_ca --overwrite   # solo si sabes lo que haces

Lee la configuración de `app.config.settings` (CA_DIR, CA_COMMON_NAME, etc.).
No imprime nunca la passphrase ni la clave privada.
"""
import argparse
import sys

from app.ca.root_ca import generate_root_ca
from app.config import settings


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Genera la CA raíz interna (Coopaspire CA). Ejecutar UNA sola vez."
    )
    parser.add_argument(
        '--overwrite',
        action='store_true',
        help="Sobrescribe una CA existente. PELIGRO: invalida los certificados ya emitidos.",
    )
    args = parser.parse_args(argv)

    if not settings.CA_KEY_PASSWORD:
        print(
            "ERROR: CA_KEY_PASSWORD no está configurada. Define la variable de "
            "entorno (fuera del repo) antes de generar la CA.",
            file=sys.stderr,
        )
        return 2

    try:
        key_file, cert_pem, cert_der = generate_root_ca(
            ca_dir=settings.CA_DIR,
            password=settings.CA_KEY_PASSWORD,
            common_name=settings.CA_COMMON_NAME,
            org=settings.CA_ORG,
            country=settings.CA_COUNTRY,
            validity_years=settings.CA_VALIDITY_YEARS,
            overwrite=args.overwrite,
        )
    except FileExistsError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 3
    except Exception as e:  # noqa: BLE001 - superficie CLI
        print(f"ERROR generando la CA: {e}", file=sys.stderr)
        return 1

    print("CA raíz generada correctamente:")
    print(f"  Nombre     : {settings.CA_COMMON_NAME} ({settings.CA_ORG}, {settings.CA_COUNTRY})")
    print(f"  Vigencia   : {settings.CA_VALIDITY_YEARS} años")
    print(f"  Clave      : {key_file}  (cifrada — CUSTODIAR y respaldar)")
    print(f"  Cert (PEM) : {cert_pem}")
    print(f"  Cert (DER) : {cert_der}  (importar en las PCs como raíz de confianza)")
    print()
    print("Siguiente paso: respaldar la clave según Docs/Custodia-CA.md y")
    print("distribuir el ca-cert.cer a las PCs (Fase 5).")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
