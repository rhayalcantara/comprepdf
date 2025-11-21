FROM python:3.11-slim

# Instalar Ghostscript y dependencias del sistema
RUN apt-get update && apt-get install -y \
    ghostscript \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar requirements e instalar dependencias
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar código
COPY . .

# Crear directorios
RUN mkdir -p /app/uploads /app/outputs

# Usuario no-root para seguridad
RUN useradd -m worker && chown -R worker:worker /app
USER worker

CMD ["celery", "-A", "app.workers.compression_worker", "worker", "--loglevel=info"]
