FROM python:3.11-slim

# Dependencias del sistema:
#   ghostscript           -> operación compress (invocado como `gs`, con -dSAFER)
#   libreoffice-*         -> operación convert (Office -> PDF) en Linux, headless.
#                            En Windows (QA) se usa COM de Microsoft Office; aquí
#                            el selector app/converters/office.py elige LibreOffice.
#   fonts-*               -> métricas y sustitución razonable de Calibri/Arial/
#                            Times en los documentos de Office convertidos.
#   libglib2.0-0          -> opencv-headless (lo arrastra pdf2docx).
#   libmagic1             -> validación de tipos.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    libreoffice-writer libreoffice-calc libreoffice-impress \
    fonts-dejavu fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
    libglib2.0-0 \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias Python primero (capa cacheable)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Código
COPY . .

RUN mkdir -p /app/uploads /app/outputs /app/ca-store

# Usuario no-root. HOME escribible: LibreOffice necesita perfil de usuario
# (office_libre.py usa uno temporal por conversión, pero el arranque lo pide).
RUN useradd -m worker && chown -R worker:worker /app
USER worker
ENV HOME=/home/worker \
    PYTHONUNBUFFERED=1

CMD ["python", "-m", "app.workers.poller"]
