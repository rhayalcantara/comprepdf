# Plan Detallado: Servicio de Compresión de PDF

## 1. ANÁLISIS Y PLANIFICACIÓN INICIAL

### 1.1 Objetivos del Servicio
- Comprimir archivos PDF manteniendo calidad aceptable
- Proporcionar diferentes niveles de compresión (baja, media, alta)
- Soportar procesamiento por lotes
- Interfaz web intuitiva y responsive
- API REST para integración con otros sistemas
- Procesamiento asíncrono para archivos grandes

### 1.2 Casos de Uso Principales
- Usuario sube un PDF y lo comprime con un clic
- Usuario selecciona nivel de compresión personalizado
- Usuario comprime múltiples PDFs simultáneamente
- Desarrolladores consumen API para automatización
- Descarga de archivos comprimidos
- Comparación antes/después (tamaño, calidad)

### 1.3 Requerimientos Técnicos
- Tamaño máximo de archivo: 50MB por PDF (configurable)
- Formatos soportados: PDF (validación estricta)
- Tiempo de procesamiento: < 30 segundos para archivos de 10MB
- Almacenamiento temporal: Limpieza automática después de 24h
- Seguridad: Validación de archivos, sanitización, HTTPS

---

## 2. ARQUITECTURA DEL SISTEMA

### 2.1 Stack Tecnológico

#### Backend API (Node.js)
- **Node.js** con **Express.js** - Framework web para API REST
- **TypeScript** - Tipado estático y mejor mantenibilidad
- **multer** - Manejo de uploads de archivos
- **Bull/BullMQ** - Sistema de colas para procesamiento asíncrono
- **Redis** - Cache y gestión de colas
- **Winston** - Logging estructurado
- **mysql2** - Driver MySQL para Node.js
- **TypeORM** - ORM para MySQL

#### Servicio de Procesamiento (Python)
- **Python 3.11+** - Motor de compresión de alta performance
- **FastAPI** - API interna para workers de compresión
- **PyPDF2 / pikepdf** - Manipulación de PDFs en Python
- **Ghostscript (via subprocess)** - Compresión avanzada
- **Celery** - Workers de procesamiento distribuido
- **Pillow** - Optimización de imágenes dentro de PDFs
- **python-magic** - Validación de tipos de archivo

#### Frontend
- **Angular 17+** con **TypeScript** - Framework robusto y enterprise-ready
- **Angular Material** - Componentes UI consistentes
- **TailwindCSS** - Estilos utility-first complementarios
- **ngx-file-drop** - Drag & drop de archivos
- **RxJS** - Manejo reactivo de estados y HTTP
- **NgRx** (opcional) - State management avanzado

#### Base de Datos
- **MySQL 8.0** - Base de datos relacional principal
- **Redis** - Cache y colas de procesamiento

#### Infraestructura
- **Docker** - Containerización
- **Docker Compose** - Orquestación local
- **Nginx** - Reverse proxy y servir estáticos
- **PM2** - Process manager para Node.js
- **Supervisor** - Process manager para Python workers

### 2.2 Arquitectura de Microservicios

```
                    ┌─────────────────┐
                    │     Nginx       │
                    │  (Reverse Proxy)│
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ▼                ▼                ▼
    ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
    │   Angular     │ │   Node.js     │ │   Python      │
    │   Frontend    │ │   API REST    │ │   Workers     │
    │   (Puerto 4200)│ │  (Puerto 3000)│ │  (Puerto 8000)│
    └───────────────┘ └───────┬───────┘ └───────┬───────┘
                              │                 │
                    ┌─────────┴─────────┐       │
                    │                   │       │
                    ▼                   ▼       ▼
            ┌───────────────┐   ┌───────────────┐
            │    MySQL      │   │    Redis      │
            │   (Puerto 3306)│   │  (Puerto 6379)│
            └───────────────┘   └───────────────┘
```

### 2.3 Estructura de Directorios

```
comprepdf/
├── backend/                      # API Node.js + Express
│   ├── src/
│   │   ├── config/              # Configuraciones
│   │   │   ├── database.ts      # Config MySQL
│   │   │   ├── redis.ts         # Config Redis
│   │   │   └── env.ts           # Variables de entorno
│   │   ├── controllers/         # Controladores de rutas
│   │   │   ├── compress.controller.ts
│   │   │   ├── file.controller.ts
│   │   │   └── stats.controller.ts
│   │   ├── services/            # Lógica de negocio
│   │   │   ├── upload.service.ts
│   │   │   ├── queue.service.ts
│   │   │   └── file.service.ts
│   │   ├── models/              # Modelos TypeORM
│   │   │   ├── job.model.ts
│   │   │   ├── file.model.ts
│   │   │   └── stats.model.ts
│   │   ├── middlewares/         # Middlewares
│   │   │   ├── upload.middleware.ts
│   │   │   ├── validation.middleware.ts
│   │   │   └── error.middleware.ts
│   │   ├── routes/              # Definición de rutas
│   │   │   └── index.ts
│   │   ├── utils/               # Utilidades
│   │   ├── types/               # TypeScript types
│   │   └── app.ts               # Aplicación Express
│   ├── tests/                   # Tests
│   ├── uploads/                 # Archivos temporales (gitignored)
│   ├── outputs/                 # PDFs comprimidos (gitignored)
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
│
├── python-worker/               # Servicio Python de compresión
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py              # FastAPI app
│   │   ├── config.py            # Configuraciones
│   │   ├── compression/         # Lógica de compresión
│   │   │   ├── __init__.py
│   │   │   ├── ghostscript.py   # Wrapper Ghostscript
│   │   │   ├── pikepdf_compressor.py
│   │   │   ├── image_optimizer.py
│   │   │   └── pdf_analyzer.py
│   │   ├── workers/             # Celery workers
│   │   │   ├── __init__.py
│   │   │   └── compression_worker.py
│   │   ├── models/              # Pydantic models
│   │   │   └── schemas.py
│   │   └── utils/
│   │       ├── file_utils.py
│   │       └── validators.py
│   ├── tests/
│   ├── requirements.txt
│   ├── Dockerfile
│   └── celeryconfig.py
│
├── frontend/                    # Angular Application
│   ├── src/
│   │   ├── app/
│   │   │   ├── core/            # Servicios singleton, guards
│   │   │   │   ├── services/
│   │   │   │   │   ├── api.service.ts
│   │   │   │   │   ├── compression.service.ts
│   │   │   │   │   └── notification.service.ts
│   │   │   │   └── interceptors/
│   │   │   │       └── error.interceptor.ts
│   │   │   ├── shared/          # Componentes compartidos
│   │   │   │   ├── components/
│   │   │   │   │   ├── file-upload/
│   │   │   │   │   ├── progress-bar/
│   │   │   │   │   └── result-card/
│   │   │   │   └── pipes/
│   │   │   ├── features/        # Módulos de features
│   │   │   │   ├── compress/
│   │   │   │   │   ├── compress.component.ts
│   │   │   │   │   ├── compress.component.html
│   │   │   │   │   └── compress.module.ts
│   │   │   │   ├── history/
│   │   │   │   └── settings/
│   │   │   ├── app.component.ts
│   │   │   ├── app.module.ts
│   │   │   └── app-routing.module.ts
│   │   ├── assets/
│   │   ├── environments/
│   │   ├── styles.scss
│   │   └── index.html
│   ├── angular.json
│   ├── package.json
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   └── Dockerfile
│
├── database/                    # Scripts de base de datos
│   ├── migrations/
│   ├── seeds/
│   └── schema.sql
│
├── docker-compose.yml
├── docker-compose.prod.yml
├── nginx/
│   └── nginx.conf
├── .env.example
├── .gitignore
└── README.md
```

---

## 3. MODELO DE BASE DE DATOS (MySQL)

### 3.1 Esquema de Tablas

```sql
-- Tabla de trabajos de compresión
CREATE TABLE compression_jobs (
    id VARCHAR(36) PRIMARY KEY,
    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
    compression_level ENUM('low', 'medium', 'high', 'custom') NOT NULL,
    custom_dpi INT NULL,
    preserve_metadata BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    error_message TEXT NULL,
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabla de archivos
CREATE TABLE files (
    id VARCHAR(36) PRIMARY KEY,
    job_id VARCHAR(36) NOT NULL,
    file_type ENUM('original', 'compressed') NOT NULL,
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    file_path VARCHAR(512) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100) DEFAULT 'application/pdf',
    checksum VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,
    FOREIGN KEY (job_id) REFERENCES compression_jobs(id) ON DELETE CASCADE,
    INDEX idx_job_id (job_id),
    INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabla de estadísticas de compresión
CREATE TABLE compression_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_id VARCHAR(36) NOT NULL,
    original_size BIGINT NOT NULL,
    compressed_size BIGINT NOT NULL,
    compression_ratio DECIMAL(5,2) NOT NULL,
    processing_time_ms INT NOT NULL,
    pages_count INT NULL,
    images_count INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES compression_jobs(id) ON DELETE CASCADE,
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabla de estadísticas globales (agregadas diariamente)
CREATE TABLE daily_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    total_jobs INT DEFAULT 0,
    successful_jobs INT DEFAULT 0,
    failed_jobs INT DEFAULT 0,
    total_original_bytes BIGINT DEFAULT 0,
    total_compressed_bytes BIGINT DEFAULT 0,
    avg_compression_ratio DECIMAL(5,2) DEFAULT 0,
    avg_processing_time_ms INT DEFAULT 0,
    INDEX idx_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabla de configuración del sistema
CREATE TABLE system_config (
    config_key VARCHAR(100) PRIMARY KEY,
    config_value TEXT NOT NULL,
    description VARCHAR(255) NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Insertar configuraciones por defecto
INSERT INTO system_config (config_key, config_value, description) VALUES
('max_file_size_mb', '50', 'Tamaño máximo de archivo en MB'),
('file_expiry_hours', '24', 'Horas hasta que expiren los archivos'),
('max_concurrent_jobs', '5', 'Máximo de trabajos concurrentes'),
('default_compression_level', 'medium', 'Nivel de compresión por defecto');
```

### 3.2 Diagrama ER

```
┌─────────────────────┐       ┌─────────────────────┐
│  compression_jobs   │       │       files         │
├─────────────────────┤       ├─────────────────────┤
│ id (PK)             │───┐   │ id (PK)             │
│ status              │   │   │ job_id (FK)         │───┐
│ compression_level   │   └──►│ file_type           │   │
│ custom_dpi          │       │ filename            │   │
│ preserve_metadata   │       │ original_filename   │   │
│ created_at          │       │ file_path           │   │
│ started_at          │       │ file_size           │   │
│ completed_at        │       │ mime_type           │   │
│ error_message       │       │ checksum            │   │
└─────────────────────┘       │ created_at          │   │
                              │ expires_at          │   │
┌─────────────────────┐       └─────────────────────┘   │
│  compression_stats  │                                 │
├─────────────────────┤                                 │
│ id (PK)             │                                 │
│ job_id (FK)         │─────────────────────────────────┘
│ original_size       │
│ compressed_size     │
│ compression_ratio   │
│ processing_time_ms  │
│ pages_count         │
│ images_count        │
│ created_at          │
└─────────────────────┘
```

---

## 4. DISEÑO DE CARACTERÍSTICAS PRINCIPALES

### 4.1 Sistema de Compresión (Python)

#### Niveles de Compresión
1. **Baja (Screen - 72 DPI)**
   - Para visualización en pantalla
   - Máxima compresión, menor calidad
   - Reducción esperada: 70-90%

2. **Media (eBook - 150 DPI)**
   - Balance calidad/tamaño
   - Para documentos de lectura digital
   - Reducción esperada: 50-70%

3. **Alta (Printer - 300 DPI)**
   - Para impresión
   - Mínima compresión, máxima calidad
   - Reducción esperada: 20-40%

4. **Personalizada**
   - Usuario define DPI y parámetros
   - Avanzado: compresión de imágenes, fuentes, etc.

#### Pipeline de Compresión Python

```python
# Flujo de procesamiento
1. Recibir archivo desde cola Redis
2. Validar PDF (magic bytes, estructura)
3. Analizar contenido (páginas, imágenes, fuentes)
4. Aplicar compresión según nivel:
   - Ghostscript para compresión general
   - Pillow para optimización de imágenes
   - pikepdf para optimización de estructura
5. Calcular métricas (ratio, tiempo)
6. Guardar resultado y actualizar DB
7. Notificar completado via Redis
```

### 4.2 API REST Endpoints (Node.js)

```
POST   /api/v1/compress              # Comprimir un PDF
POST   /api/v1/compress/batch        # Comprimir múltiples PDFs
GET    /api/v1/jobs/:jobId           # Estado de procesamiento
GET    /api/v1/jobs/:jobId/download  # Descargar PDF comprimido
DELETE /api/v1/jobs/:jobId           # Eliminar trabajo y archivos
GET    /api/v1/stats                 # Estadísticas del servicio
GET    /api/v1/stats/daily           # Estadísticas diarias
POST   /api/v1/analyze               # Analizar PDF sin comprimir
GET    /api/v1/health                # Health check
```

#### Ejemplo de Request/Response

**POST /api/v1/compress**
```json
Request (multipart/form-data):
{
  "file": <PDF binary>,
  "compressionLevel": "medium",
  "options": {
    "preserveMetadata": true,
    "customDpi": null
  }
}

Response (201 Created):
{
  "success": true,
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "pending",
    "originalFilename": "documento.pdf",
    "originalSize": 5242880,
    "compressionLevel": "medium",
    "createdAt": "2025-11-21T10:30:00Z",
    "estimatedTime": 15
  }
}
```

**GET /api/v1/jobs/:jobId**
```json
Response (200 OK):
{
  "success": true,
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "originalFilename": "documento.pdf",
    "originalSize": 5242880,
    "compressedSize": 1572864,
    "compressionRatio": 70.0,
    "processingTimeMs": 12500,
    "downloadUrl": "/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000/download",
    "expiresAt": "2025-11-22T10:30:00Z",
    "createdAt": "2025-11-21T10:30:00Z",
    "completedAt": "2025-11-21T10:30:12Z"
  }
}
```

### 4.3 Interfaz de Usuario (Angular)

#### Componentes Principales

```typescript
// Estructura de componentes Angular
src/app/
├── features/
│   ├── compress/
│   │   ├── components/
│   │   │   ├── upload-zone/         // Drag & drop area
│   │   │   ├── compression-options/ // Selector de nivel
│   │   │   ├── file-list/           // Lista de archivos
│   │   │   └── result-panel/        // Resultados
│   │   ├── compress.component.ts
│   │   └── compress.module.ts
│   ├── history/                     // Historial de compresiones
│   └── stats/                       // Dashboard de estadísticas
├── shared/
│   ├── components/
│   │   ├── header/
│   │   ├── footer/
│   │   ├── progress-bar/
│   │   ├── file-size-pipe/
│   │   └── loading-spinner/
│   └── shared.module.ts
└── core/
    ├── services/
    │   ├── api.service.ts
    │   └── compression.service.ts
    └── models/
        ├── job.model.ts
        └── file.model.ts
```

#### Pantalla Principal
- **Header**: Logo, navegación, tema oscuro/claro
- **Upload Zone**:
  - Drag & drop area con ngx-file-drop
  - Click to browse
  - Indicador de progreso con mat-progress-bar
  - Validación en tiempo real (tipo, tamaño)
- **Configuración**:
  - Mat-radio para nivel de compresión
  - Mat-expansion-panel para opciones avanzadas
  - Preview de configuración
- **Lista de Archivos**:
  - Mat-table con archivos en cola
  - Estado con mat-chip
  - Barra de progreso individual
- **Resultados**:
  - Mat-card con comparación antes/después
  - Porcentaje de reducción con animación
  - Botones de descarga y eliminar
  - Snackbar para notificaciones

---

## 5. COMUNICACIÓN ENTRE SERVICIOS

### 5.1 Flujo de Compresión

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Angular │────►│ Node.js  │────►│  Redis   │────►│  Python  │
│ Frontend │     │   API    │     │  Queue   │     │  Worker  │
└──────────┘     └────┬─────┘     └──────────┘     └────┬─────┘
                      │                                  │
                      │         ┌──────────┐             │
                      └────────►│  MySQL   │◄────────────┘
                                │    DB    │
                                └──────────┘

Flujo:
1. Usuario sube PDF → Angular
2. Angular envía a Node.js API
3. Node.js guarda archivo, crea job en MySQL, encola en Redis
4. Python Worker toma job de Redis
5. Python comprime PDF usando Ghostscript/pikepdf
6. Python actualiza MySQL con resultado
7. Python notifica completado via Redis pub/sub
8. Node.js recibe notificación, puede usar WebSockets para notificar Angular
9. Angular polling o WebSocket recibe actualización
10. Usuario descarga PDF comprimido
```

### 5.2 Comunicación Redis

```python
# Python Worker - Celery task
@celery_app.task(bind=True)
def compress_pdf_task(self, job_id: str):
    # Obtener datos del job desde MySQL
    # Comprimir PDF
    # Actualizar MySQL
    # Publicar resultado
    redis_client.publish('compression_complete', json.dumps({
        'job_id': job_id,
        'status': 'completed'
    }))
```

```typescript
// Node.js - Escuchar eventos
const subscriber = redis.createClient();
subscriber.subscribe('compression_complete');
subscriber.on('message', (channel, message) => {
    const data = JSON.parse(message);
    // Notificar via WebSocket si está implementado
    // O simplemente el frontend hace polling
});
```

---

## 6. IMPLEMENTACIÓN PYTHON - MOTOR DE COMPRESIÓN

### 6.1 Estructura del Worker

```python
# python-worker/app/compression/ghostscript.py
import subprocess
from pathlib import Path
from typing import Literal

CompressionLevel = Literal['low', 'medium', 'high', 'custom']

COMPRESSION_SETTINGS = {
    'low': '/screen',      # 72 DPI
    'medium': '/ebook',    # 150 DPI
    'high': '/printer',    # 300 DPI
}

class GhostscriptCompressor:
    def __init__(self, gs_path: str = 'gs'):
        self.gs_path = gs_path

    def compress(
        self,
        input_path: Path,
        output_path: Path,
        level: CompressionLevel = 'medium',
        custom_dpi: int = None
    ) -> dict:
        """Comprime un PDF usando Ghostscript."""

        if level == 'custom' and custom_dpi:
            cmd = self._build_custom_command(input_path, output_path, custom_dpi)
        else:
            cmd = self._build_preset_command(input_path, output_path, level)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300  # 5 minutos máximo
        )

        if result.returncode != 0:
            raise Exception(f"Ghostscript error: {result.stderr}")

        return {
            'original_size': input_path.stat().st_size,
            'compressed_size': output_path.stat().st_size,
        }

    def _build_preset_command(self, input_path, output_path, level):
        return [
            self.gs_path,
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.4',
            f'-dPDFSETTINGS={COMPRESSION_SETTINGS[level]}',
            '-dNOPAUSE',
            '-dQUIET',
            '-dBATCH',
            '-dSAFER',  # Modo seguro
            f'-sOutputFile={output_path}',
            str(input_path)
        ]

    def _build_custom_command(self, input_path, output_path, dpi):
        return [
            self.gs_path,
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.4',
            f'-dDownsampleColorImages=true',
            f'-dColorImageResolution={dpi}',
            f'-dDownsampleGrayImages=true',
            f'-dGrayImageResolution={dpi}',
            f'-dDownsampleMonoImages=true',
            f'-dMonoImageResolution={dpi}',
            '-dNOPAUSE',
            '-dQUIET',
            '-dBATCH',
            '-dSAFER',
            f'-sOutputFile={output_path}',
            str(input_path)
        ]
```

### 6.2 Celery Worker

```python
# python-worker/app/workers/compression_worker.py
from celery import Celery
from app.compression.ghostscript import GhostscriptCompressor
from app.config import settings
import mysql.connector
import time
from pathlib import Path

celery_app = Celery('compression_worker')
celery_app.config_from_object('celeryconfig')

compressor = GhostscriptCompressor()

@celery_app.task(bind=True, max_retries=3)
def process_compression_job(self, job_id: str):
    """Procesa un trabajo de compresión."""
    start_time = time.time()

    try:
        # Conectar a MySQL y obtener datos del job
        conn = mysql.connector.connect(**settings.MYSQL_CONFIG)
        cursor = conn.cursor(dictionary=True)

        # Obtener job y archivo original
        cursor.execute("""
            SELECT j.*, f.file_path, f.original_filename
            FROM compression_jobs j
            JOIN files f ON f.job_id = j.id
            WHERE j.id = %s AND f.file_type = 'original'
        """, (job_id,))
        job = cursor.fetchone()

        if not job:
            raise Exception(f"Job {job_id} not found")

        # Actualizar estado a processing
        cursor.execute("""
            UPDATE compression_jobs
            SET status = 'processing', started_at = NOW()
            WHERE id = %s
        """, (job_id,))
        conn.commit()

        # Preparar paths
        input_path = Path(job['file_path'])
        output_filename = f"compressed_{job['original_filename']}"
        output_path = Path(settings.OUTPUT_DIR) / output_filename

        # Comprimir
        result = compressor.compress(
            input_path=input_path,
            output_path=output_path,
            level=job['compression_level'],
            custom_dpi=job.get('custom_dpi')
        )

        processing_time = int((time.time() - start_time) * 1000)
        compression_ratio = round(
            (1 - result['compressed_size'] / result['original_size']) * 100, 2
        )

        # Guardar archivo comprimido en DB
        import uuid
        file_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO files (id, job_id, file_type, filename, original_filename,
                              file_path, file_size, expires_at)
            VALUES (%s, %s, 'compressed', %s, %s, %s, %s,
                    DATE_ADD(NOW(), INTERVAL 24 HOUR))
        """, (file_id, job_id, output_filename, job['original_filename'],
              str(output_path), result['compressed_size']))

        # Guardar estadísticas
        cursor.execute("""
            INSERT INTO compression_stats
            (job_id, original_size, compressed_size, compression_ratio, processing_time_ms)
            VALUES (%s, %s, %s, %s, %s)
        """, (job_id, result['original_size'], result['compressed_size'],
              compression_ratio, processing_time))

        # Actualizar estado a completed
        cursor.execute("""
            UPDATE compression_jobs
            SET status = 'completed', completed_at = NOW()
            WHERE id = %s
        """, (job_id,))

        conn.commit()

        return {'status': 'completed', 'job_id': job_id}

    except Exception as e:
        # Actualizar estado a failed
        cursor.execute("""
            UPDATE compression_jobs
            SET status = 'failed', error_message = %s
            WHERE id = %s
        """, (str(e), job_id))
        conn.commit()

        raise self.retry(exc=e, countdown=60)  # Reintentar en 60s

    finally:
        cursor.close()
        conn.close()
```

### 6.3 requirements.txt

```
# python-worker/requirements.txt
fastapi==0.104.1
uvicorn==0.24.0
celery==5.3.4
redis==5.0.1
mysql-connector-python==8.2.0
pikepdf==8.7.1
Pillow==10.1.0
python-magic==0.4.27
pydantic==2.5.2
python-multipart==0.0.6
python-dotenv==1.0.0
```

---

## 7. IMPLEMENTACIÓN DETALLADA POR FASES

### 7.1 Fase 1: Setup Inicial (Semana 1)

#### Día 1-2: Configuración del Proyecto
- [ ] Inicializar repositorio Git
- [ ] Crear estructura de directorios completa
- [ ] Configurar Docker Compose con MySQL, Redis
- [ ] Crear scripts de base de datos (schema.sql)
- [ ] Configurar variables de entorno (.env.example)
- [ ] Crear .gitignore apropiado

#### Día 3-4: Backend Node.js Base
- [ ] Inicializar proyecto Node.js con Express
- [ ] Configurar TypeScript compiler
- [ ] Instalar y configurar TypeORM con MySQL
- [ ] Crear modelos de base de datos
- [ ] Configurar conexión Redis
- [ ] Setup de logging con Winston
- [ ] Crear health check endpoint

#### Día 5-7: Python Worker Base
- [ ] Inicializar proyecto Python con FastAPI
- [ ] Configurar Celery con Redis
- [ ] Instalar Ghostscript en sistema/Docker
- [ ] Crear wrapper básico de Ghostscript
- [ ] Configurar conexión MySQL
- [ ] Tests básicos de compresión

### 7.2 Fase 2: Funcionalidad Core (Semana 2-3)

#### Semana 2: Upload y Sistema de Colas
- [ ] Implementar Multer para file uploads en Node.js
- [ ] Crear validación de archivos PDF
- [ ] Implementar creación de jobs en MySQL
- [ ] Integrar con cola Redis (BullMQ)
- [ ] Crear endpoint POST /api/v1/compress
- [ ] Tests de upload e integración

#### Semana 3: Motor de Compresión Python
- [ ] Implementar GhostscriptCompressor completo
- [ ] Crear Celery task para procesamiento
- [ ] Implementar niveles de compresión
- [ ] Crear servicio de análisis de PDFs
- [ ] Implementar cálculo de métricas
- [ ] Tests de compresión exhaustivos

### 7.3 Fase 3: API REST Completa (Semana 4)

#### Node.js Endpoints
- [ ] GET /api/v1/jobs/:jobId - Estado del trabajo
- [ ] GET /api/v1/jobs/:jobId/download - Descarga
- [ ] DELETE /api/v1/jobs/:jobId - Eliminar
- [ ] POST /api/v1/compress/batch - Lotes
- [ ] GET /api/v1/stats - Estadísticas
- [ ] POST /api/v1/analyze - Analizar sin comprimir
- [ ] Documentación OpenAPI/Swagger

#### Validación y Seguridad
- [ ] Validación con Joi
- [ ] Rate limiting con express-rate-limit
- [ ] Sanitización de inputs
- [ ] Verificación de tipos MIME
- [ ] Helmet.js para headers de seguridad

### 7.4 Fase 4: Frontend Angular (Semana 5-6)

#### Semana 5: Setup y Componentes Base
- [ ] Inicializar proyecto Angular 17+
- [ ] Configurar Angular Material
- [ ] Configurar TailwindCSS
- [ ] Crear estructura de módulos
- [ ] Implementar ApiService
- [ ] Crear componentes compartidos (header, footer, etc.)

#### Semana 6: Features Principales
- [ ] Implementar UploadZone con ngx-file-drop
- [ ] Crear CompressionOptions component
- [ ] Implementar FileList con mat-table
- [ ] Crear ResultPanel con comparación
- [ ] Implementar polling de estado
- [ ] Manejo de errores con interceptors
- [ ] Loading states y animaciones

### 7.5 Fase 5: Integración y Testing (Semana 7)

#### Integración
- [ ] Conectar Angular con API Node.js
- [ ] Implementar flujo completo de compresión
- [ ] Implementar descarga de archivos
- [ ] Agregar notificaciones con mat-snackbar
- [ ] Optimizar polling o implementar WebSockets

#### Testing
- [ ] Tests unitarios Node.js (Jest)
- [ ] Tests unitarios Python (pytest)
- [ ] Tests unitarios Angular (Jasmine/Karma)
- [ ] Tests de integración API (Supertest)
- [ ] Tests E2E con Cypress o Playwright

### 7.6 Fase 6: Limpieza y Optimización (Semana 8)

#### Tareas de Mantenimiento
- [ ] Implementar job de limpieza de archivos expirados
- [ ] Optimizar queries MySQL (índices, explain)
- [ ] Implementar logging estructurado completo
- [ ] Agregar métricas de performance
- [ ] Optimizar compresión para archivos grandes
- [ ] Lazy loading en Angular
- [ ] Bundle optimization

### 7.7 Fase 7: Dockerización y Deploy (Semana 9)

#### Docker
- [ ] Dockerfile optimizado para Node.js (multi-stage)
- [ ] Dockerfile para Python con Ghostscript
- [ ] Dockerfile para Angular (nginx)
- [ ] Docker Compose para desarrollo
- [ ] Docker Compose para producción
- [ ] Health checks en contenedores

#### Deployment
- [ ] Configurar Nginx como reverse proxy
- [ ] Configurar SSL/HTTPS (Let's Encrypt)
- [ ] Setup PM2 para Node.js
- [ ] Setup Supervisor para Python workers
- [ ] Configurar logs centralizados
- [ ] Scripts de backup de MySQL

---

## 8. CONFIGURACIÓN DOCKER

### 8.1 docker-compose.yml

```yaml
version: '3.8'

services:
  # Base de datos MySQL
  mysql:
    image: mysql:8.0
    container_name: comprepdf-mysql
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: comprepdf
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
      - ./database/schema.sql:/docker-entrypoint-initdb.d/schema.sql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis para colas
  redis:
    image: redis:7-alpine
    container_name: comprepdf-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Backend Node.js API
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: comprepdf-backend
    restart: unless-stopped
    environment:
      NODE_ENV: development
      PORT: 3000
      MYSQL_HOST: mysql
      MYSQL_PORT: 3306
      MYSQL_DATABASE: comprepdf
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      REDIS_HOST: redis
      REDIS_PORT: 6379
    ports:
      - "3000:3000"
    volumes:
      - ./backend:/app
      - /app/node_modules
      - uploads_data:/app/uploads
      - outputs_data:/app/outputs
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  # Python Worker para compresión
  python-worker:
    build:
      context: ./python-worker
      dockerfile: Dockerfile
    container_name: comprepdf-python-worker
    restart: unless-stopped
    environment:
      MYSQL_HOST: mysql
      MYSQL_PORT: 3306
      MYSQL_DATABASE: comprepdf
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      REDIS_HOST: redis
      REDIS_PORT: 6379
      UPLOAD_DIR: /app/uploads
      OUTPUT_DIR: /app/outputs
    volumes:
      - ./python-worker:/app
      - uploads_data:/app/uploads
      - outputs_data:/app/outputs
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy
    command: celery -A app.workers.compression_worker worker --loglevel=info

  # Frontend Angular
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    container_name: comprepdf-frontend
    restart: unless-stopped
    ports:
      - "4200:80"
    depends_on:
      - backend

  # Nginx Reverse Proxy (producción)
  nginx:
    image: nginx:alpine
    container_name: comprepdf-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
      - ./nginx/ssl:/etc/nginx/ssl
    depends_on:
      - backend
      - frontend
    profiles:
      - production

volumes:
  mysql_data:
  redis_data:
  uploads_data:
  outputs_data:
```

### 8.2 Dockerfile Python Worker

```dockerfile
# python-worker/Dockerfile
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
```

---

## 9. CONSIDERACIONES DE SEGURIDAD

### 9.1 Validación de Archivos
- Verificar magic bytes del PDF (%PDF-)
- Limitar tamaño de archivo (50MB default)
- Validar estructura del PDF con pikepdf
- Rechazar PDFs encriptados o protegidos
- Sanitizar nombres de archivo

### 9.2 Protección del Sistema
- Ejecutar Ghostscript en modo sandbox (-dSAFER)
- Limitar recursos en Docker (CPU, memoria)
- Timeout en procesos de compresión (5 min máx)
- Worker Python como usuario no-root
- Aislar procesamiento de archivos

### 9.3 API Security
- Rate limiting por IP (100 req/15min)
- CORS configurado estrictamente
- Validación estricta de inputs con Joi
- Helmet.js para headers de seguridad
- Logs de auditoría
- Prepared statements en MySQL (TypeORM/mysql-connector)

### 9.4 Datos del Usuario
- Eliminar archivos después de 24h (cron job)
- No registrar contenido de PDFs en logs
- HTTPS obligatorio en producción
- UUIDs para IDs (no secuenciales)

---

## 10. MONITOREO Y MÉTRICAS

### 10.1 Métricas Clave (KPIs)
- Número de compresiones por día/hora
- Ratio promedio de compresión
- Tiempo promedio de procesamiento
- Tasa de errores
- Tamaño promedio de archivos
- Uso de almacenamiento
- Longitud de cola Redis
- Conexiones activas MySQL

### 10.2 Logs
- **INFO**: Compresiones exitosas, estadísticas
- **WARN**: Archivos rechazados, límites alcanzados
- **ERROR**: Fallos de compresión, errores de sistema
- Formato JSON estructurado
- Rotación de logs diaria

### 10.3 Health Checks
- `/api/v1/health` - Estado general
- Verificación de MySQL connection
- Verificación de Redis connection
- Estado de workers Celery

---

## 11. ESTIMACIÓN DE RECURSOS

### 11.1 Desarrollo Local
- CPU: 4 cores (2 mínimo)
- RAM: 8GB (4GB mínimo)
- Disco: 20GB SSD
- Docker Desktop instalado

### 11.2 Producción (Inicial)
- CPU: 4 cores
- RAM: 8GB
- Disco: 50GB SSD
- MySQL: 2GB RAM dedicado
- Redis: 512MB RAM dedicado

### 11.3 Costos Estimados (Cloud)
- VPS (DigitalOcean/Linode): $40-60/mes
- Managed MySQL (opcional): $15-25/mes
- CDN (opcional): $5-10/mes
- Dominio: $10-15/año
- SSL: Gratis (Let's Encrypt)
- **Total inicial: ~$50-80/mes**

---

## 12. DEPENDENCIAS CLAVE

### 12.1 Backend Node.js (package.json)

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "typescript": "^5.3.3",
    "typeorm": "^0.3.17",
    "mysql2": "^3.6.5",
    "multer": "^1.4.5-lts.1",
    "bullmq": "^4.14.0",
    "redis": "^4.6.10",
    "winston": "^3.11.0",
    "dotenv": "^16.3.1",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "joi": "^17.11.0",
    "uuid": "^9.0.1",
    "express-rate-limit": "^7.1.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/multer": "^1.4.11",
    "@types/node": "^20.10.4",
    "@types/cors": "^2.8.17",
    "@types/uuid": "^9.0.7",
    "ts-node-dev": "^2.0.0",
    "jest": "^29.7.0",
    "@types/jest": "^29.5.11",
    "supertest": "^6.3.3"
  }
}
```

### 12.2 Frontend Angular (package.json)

```json
{
  "dependencies": {
    "@angular/core": "^17.0.0",
    "@angular/common": "^17.0.0",
    "@angular/forms": "^17.0.0",
    "@angular/router": "^17.0.0",
    "@angular/material": "^17.0.0",
    "@angular/cdk": "^17.0.0",
    "@angular/animations": "^17.0.0",
    "rxjs": "^7.8.1",
    "ngx-file-drop": "^16.0.0"
  },
  "devDependencies": {
    "@angular/cli": "^17.0.0",
    "@angular/compiler-cli": "^17.0.0",
    "typescript": "^5.2.2",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.32",
    "autoprefixer": "^10.4.16",
    "karma": "^6.4.2",
    "jasmine-core": "^5.1.1"
  }
}
```

---

## 13. CHECKLIST FINAL ANTES DEL LAUNCH

- [ ] Tests pasando (unit, integration, e2e) > 80% coverage
- [ ] Documentación completa (README, API docs Swagger)
- [ ] Variables de entorno configuradas en producción
- [ ] SSL/HTTPS configurado con Let's Encrypt
- [ ] Rate limiting activo y configurado
- [ ] Logs configurados y rotando (Winston + logrotate)
- [ ] Health checks funcionando
- [ ] Backup strategy de MySQL definida y probada
- [ ] Cleanup de archivos temporales funcionando (cron)
- [ ] Error handling robusto en todos los servicios
- [ ] UI/UX revisado y responsive
- [ ] Performance testing realizado (Artillery)
- [ ] Security audit básico completado
- [ ] Dominio y DNS configurados
- [ ] Monitoreo activo (uptime, errores)
- [ ] Docker images optimizadas (multi-stage builds)
- [ ] Documentación de deployment actualizada

---

## CONCLUSIÓN

Este plan reestructurado incorpora:

1. **Angular** como framework frontend (enterprise-ready, TypeScript nativo)
2. **MySQL** como base de datos relacional principal
3. **Python** como motor de compresión para mayor performance y flexibilidad
4. **Arquitectura de microservicios** con comunicación via Redis

**Ventajas de esta arquitectura:**
- Python es más eficiente para procesamiento de archivos pesados
- Ghostscript se integra mejor con Python (subprocess, wrappers maduros)
- Angular ofrece estructura más sólida para aplicaciones enterprise
- MySQL es más familiar y tiene excelente tooling
- Separación clara de responsabilidades entre servicios

**Timeline estimado: 9 semanas** con un desarrollador full-stack experimentado.

**¿Listo para comenzar la implementación?**
