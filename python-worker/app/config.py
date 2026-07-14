import os
from dotenv import load_dotenv

load_dotenv()

class Settings:
    MYSQL_HOST = os.getenv('MYSQL_HOST', 'localhost')
    MYSQL_PORT = int(os.getenv('MYSQL_PORT', '3306'))
    MYSQL_DATABASE = os.getenv('MYSQL_DATABASE', 'comprepdf')
    MYSQL_USER = os.getenv('MYSQL_USER', 'comprepdf')
    MYSQL_PASSWORD = os.getenv('MYSQL_PASSWORD', 'comprepdf123')

    REDIS_HOST = os.getenv('REDIS_HOST', 'localhost')
    REDIS_PORT = int(os.getenv('REDIS_PORT', '6379'))

    UPLOAD_DIR = os.getenv('UPLOAD_DIR', './uploads')
    OUTPUT_DIR = os.getenv('OUTPUT_DIR', './outputs')

    # --- CA interna de la cooperativa (módulo de certificados) ---
    # Directorio donde se custodian la clave y el certificado raíz. Debe quedar
    # FUERA del repo (ver .gitignore) y con acceso restringido.
    CA_DIR = os.getenv('CA_DIR', './ca-store')
    # Passphrase que cifra la clave privada raíz. Sin valor por defecto a
    # propósito: generar o cargar la CA falla si no está configurada.
    CA_KEY_PASSWORD = os.getenv('CA_KEY_PASSWORD', '')
    # Atributos del certificado raíz.
    CA_COMMON_NAME = os.getenv('CA_COMMON_NAME', 'Coopaspire CA')
    CA_ORG = os.getenv('CA_ORG', 'Coopaspire')
    CA_COUNTRY = os.getenv('CA_COUNTRY', 'DO')
    CA_VALIDITY_YEARS = int(os.getenv('CA_VALIDITY_YEARS', '15'))

    @property
    def MYSQL_CONFIG(self):
        return {
            'host': self.MYSQL_HOST,
            'port': self.MYSQL_PORT,
            'database': self.MYSQL_DATABASE,
            'user': self.MYSQL_USER,
            'password': self.MYSQL_PASSWORD,
        }

    @property
    def REDIS_URL(self):
        return f'redis://{self.REDIS_HOST}:{self.REDIS_PORT}/0'

settings = Settings()
