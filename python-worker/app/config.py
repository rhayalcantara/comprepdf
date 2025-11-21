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
