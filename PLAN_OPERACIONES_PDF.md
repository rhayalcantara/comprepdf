# PLAN: Nuevas Operaciones PDF - Dividir, Unir, Firmar y Más

## Visión General

Extender ComprePDF paraSoporta 7 operaciones PDF sobre la misma infraestructura de colas existente.

## Operaciones a Implementar

| # | Operación | Endpoint | Worker Python | Frontend | Descripción |
|---|-----------|----------|---------------|----------|-------------|
| 1 | Split PDF | `POST /pdf/split` | `process_split_job` | `pdf-tools/` | Dividir PDF en páginas/rangos |
| 2 | Merge PDFs | `POST /pdf/merge` | `process_merge_job` | `pdf-tools/` | Unir múltiples PDFs en uno |
| 3 | Sign PDF | `POST /pdf/sign` | `process_sign_job` | `pdf-tools/` | Agregar watermark/firma visual |
| 4 | Extract Pages | `POST /pdf/extract` | `process_extract_job` | `pdf-tools/` | Extraer páginas específicas |
| 5 | Rotate Pages | `POST /pdf/rotate` | `process_rotate_job` | `pdf-tools/` | Rotar páginas de PDF |
| 6 | Protect PDF | `POST /pdf/protect` | `process_protect_job` | `pdf-tools/` | Agregar contraseña |
| 7 | Unlock PDF | `POST /pdf/unlock` | `process_unlock_job` | `pdf-tools/` | Remover contraseña |

## Arquitectura de Solución

```
Angular (4200) → Node.js API (3000) → Redis Queue → Python Worker (8000)
                                       (new routes)              (new tasks)
```

- Mismo patrón `compression_jobs` + `files` + `compression_stats`
- Nueva columna `operation_type` en `compression_jobs`
- Cada operación tiene su propio task de Celery en un archivo modular
- Frontend single-page con Tabs para cada operación

## Fases de Implementación

---

### FASE 1: Backend Database & Model (≈1 hora)

**1.1. Actualizar schema SQL**

Archivo: `database/schema.sql`

```sql
-- Agregar a tabla compression_jobs
ALTER TABLE compression_jobs
  ADD COLUMN operation_type ENUM('compress', 'split', 'merge', 'sign', 'extract', 'rotate', 'protect', 'unlock') DEFAULT 'compress' AFTER status,
  ADD COLUMN operation_params JSON NULL,
  ADD COLUMN files_output INT NULL DEFAULT NULL;

-- Migrar valores existentes
UPDATE compression_jobs SET operation_type = 'compress' WHERE operation_type IS NULL;
```

**1.2. Actualizar model Typescript**

Archivo: `backend/src/models/job.model.ts`
- Agregar tipo `OperationType`
- Agregar campos `operationType`, `operationParams`, `filesOutput` a `CompressionJob`

---

### FASE 2: Backend Controllers & Routes (≈2 horas)

**2.1. Nuevo controlador - Operaciones PDF**

Archivo: `backend/src/controllers/pdf-operation.controller.ts`

Funciones a exportar:
- `splitPdf` - Recibe 1 PDF + params (pageRanges o individual)
- `mergePdfs` - Recibe múltiples archivos (FormData con `files[]`)
- `signPdf` - Recibe 1 PDF + text/color/position
- `extractPages` - Recibe 1 PDF + pageNumbers
- `rotatePages` - Recibe 1 PDF + pageNumbers + degrees
- `protectPdf` - Recibe 1 PDF + password
- `unlockPdf` - Recibe 1 PDF + password
- `getPdfOperationStatus` - Reusa patrón de `getJobStatus`
- `downloadPdfOutput` - Reusa patrón de `downloadFile`
- `deletePdfJob` - Reusa patrón de `deleteJob`

**2.2. Actualizar routes**

Archivo: `backend/src/routes/index.ts`

```typescript
// PDF Operations routes
import {
  splitPdf, mergePdfs, signPdf, extractPages,
  rotatePages, protectPdf, unlockPdf,
  getPdfOperationStatus, downloadPdfOutput, deletePdfJob
} from '../controllers/pdf-operation.controller';

// Multi-file upload middleware necesario para merge
router.post('/pdf/split', uploadMultipleFiles.any(), splitPdf);
router.post('/pdf/merge', uploadMultipleFiles.array('files', 50), mergePdfs);
router.post('/pdf/sign', upload.single('file'), signPdf);
router/post('/pdf/extract', upload.single('file'), extractPages);
router.post('/pdf/rotate', upload.single('file'), rotatePages);
router.post('/pdf/protect', upload.single('file'), protectPdf);
router.post('/pdf/unlock', upload.single('file'), unlockPdf);
router.get('/pdf/jobs/:jobId', getPdfOperationStatus);
router.get('/pdf/jobs/:jobId/download', downloadPdfOutput);
router.delete('/pdf/jobs/:jobId', deletePdfJob);
```

**2.3. Middleware upload para múltiples archivos**

Archivo: `backend/src/middlewares/upload.middleware.ts` - agregar función `uploadMultipleFiles`

---

### FASE 3: Python Worker Tasks (≈2 horas)

**3.1. Nueva estructura de workers**

Archivo: `python-worker/app/workers/pdf_operations.py`

```python
import fitz  # PyMuPDF
from pathlib import Path
from celery import group

from app.config import settings

@celery_app.task(bind=True, max_retries=3, name='split-pdf')
def process_split_job(self, job_id: str, page_ranges: list = None, individual: bool = False):
    """Divide PDF en páginas o rangos."""
    # 1. Abrir PDF con fitz.open()
    # 2. Split por ranges o individual
    # 3. Guardar cada pagina como archivo numerado (input_1.pdf, input_2.pdf)
    # 4. Actualizar DB con múltiple archivos output
    # 5. Retornar count de archivos creados

@celery_app.task(bind=True, max_retries=3, name='merge-pdf')
def process_merge_job(self, job_id: str, file_order: list = None):
    """Une múltiples PDFs en uno."""
    # 1. Abrir todos los PDFs con fitz.open()
    # 2. Union con master.append()
    # 3. Guardar resultado
    # 4. Actualizar DB

@celery_app.task(bind=True, max_retries=3, name='sign-pdf')
def process_sign_job(self, job_id: str, text: str = 'Approved', color: str = '#000000', position: str = 'bottom-right'):
    """Agrepa watermark/firma visual."""
    # 1. Abrir PDF con fitz.open()
    # 2. Agregar texto como annotation en página específica
    # 3. Guardar con marca de agua
    # 4. Actualizar DB

@celery_app.task(bind=True, max_retries=3, name='extract-pages')
def process_extract_job(self, job_id: str, page_numbers: list):
    """Extrae páginas específicas."""
    # 1. Abrir PDF con fitz.open()
    # 2. Crear nuevo PDF con solo las páginas solicitadas
    # 3. Guardar resultado
    # 4. Actualizar DB

@celery_app.task(bind=True, max_retries=3, name='rotate-pages')
def process_rotate_job(self, job_id: str, page_numbers: list, degrees: int = 90):
    """Rota páginas de un PDF."""
    # 1. Abrir PDF con fitz.open() 2. Rotar páginas con page.rotate()
    # 3. Guardar resultado
    # 4. Actualizar DB

@celery_app.task(bind=True, max_retries=3, name='protect-pdf')
def process_protect_job(self, job_id: str, password: str, owner_password: str = None):
    """Agrega protección con contraseña."""
    # 1. Abrir PDF con fitz.open()
    # 2. Guardar con encryption con fitz.open().save()
    # 3. Guardar resultado
    # 4. Actualizar DB

@celery_app.task(bind=True, max_retries=3, name='unlock-pdf')
def process_unlock_job(self, job_id: str, password: str):
    """Remueve protección de PDF."""
    # 1. Abrir con contraseña con fitz.open()
    # 2. Guardar sin cifrado
    # 3. Actualizar DB
```

**3.2. requirements.txt**

Archivo: `python-worker/requirements.txt` - agregar `PyMuPDF`

---

### FASE 4: Frontend PDF Tools Page (≈2 horas)

**4.1. Nuevo feature module**

Estructura de archivos a crear:
```
frontend/src/app/features/pdf-tools/
├── pdf-tools.component.ts
├── pdf-tools.component.html
├── pdf-tools.component.scss
```

**4.2. Components Tabs**

- Split PDF: selector de archivo + opciones (Individual / Rangos personalizado)
- Merge: drag & drop múltiple + orden draggble
- Sign: texto de firma + color picker + posición
- Extract: lista de números de página
- Rotate: selector de páginas + grados (90/180/270)
- Protect: campo de contraseña
- Unlock: campo de contraseña

**4.3. Actualizar API Service**

Archivo: `frontend/src/app/core/services/api.service.ts` - agregar métodos:
```typescript
splitPdf(file: File, params: SplitParams): Observable<ApiResponse<...>>
mergePdfs(files: File[]): Observable<ApiResponse<...>>
signPdf(file: File, params: SignParams): Observable<ApiResponse<...>>
extractPages(file: File, params: ExtractParams): Observable<ApiResponse<...>>
rotatePages(file: File, params: RotateParams): Observable<ApiResponse<...>>
protectPdf(file: File, params: ProtectParams): Observable<ApiResponse<...>>
unlockPdf(file: File, params: UnlockParams): Observable<ApiResponse<...>>
```

**4.4. Actualizar Routes**

Archivo: `frontend/src/app/app.routes.ts` - agregar ruta `/pdf-tools`

**4.5. Actualizar navegación**

Actualizar `app.component.ts` para incluir enlace a la nueva página de herramientas PDF.

---

### FASE 5: Integración & Testing (≈1 hora)

**5.1. Docker Compose**

Verificar que `python-worker` Dockerfile tiene:
```dockerfile
RUN pip install PyMuPDF
```

**5.2. Pruebas end-to-end**

Para cada operación:
1. Upload archivo → verificar creación de job
2. Verificar estado → pending → processing → completed
3. Descargar output → verificar integridad
4. Probar casos de error (archivo no existe, contraseña incorrecta, etc.)

**5.3. Test de integración**

Escribe tests para cada operación Python:
- `python-worker/tests/test_pdf_operations.py`
- Split: 10 páginas → 10 archivos individuales
- Merge: 3 PDFs → 1 PDF con suma de páginas
- Sign: verificar texto aparece en output
- Extract: 10 páginas → 3 páginas extraídas
- Rotate: verificar grados de rotación
- Protect: verificar que se necesita contraseña
- Unlock: verificar que contraseña se removió

---

## Dependencias

| Fase | Depende de |
|------|-----------|
| 1 | N/A - base |
| 2 | Fase 1 (schema) |
| 3 | Fase 1 (schema), Fase 2 (DB access) |
| 4 | Fase 2 (backend endpoints) |
| 5 | Todas las fases anteriores |

## Resumen de Archivos a Crear/Modificar

### Backend (3 archivos nuevos, 2 modificados)
- `backend/src/controllers/pdf-operation.controller.ts` ← NUEVO
- `backend/src/middlewares/multifile-upload.middleware.ts` ← NUEVO (opcional, puede ir en upload.middleware.ts existente)
- `python-worker/app/workers/pdf_operations.py` ← NUEVO
- `database/schema.sql` ← MODIFICADO
- `backend/src/models/job.model.ts` ← MODIFICADO
- `backend/src/routes/index.ts` ← MODIFICADO

### Python Worker (2 archivos nuevos, 1 modificado)
- `python-worker/app/workers/pdf_operations.py` ← NUEVO
- `python-worker/requirements.txt` ← MODIFICADO
- `python-worker/tests/test_pdf_operations.py` ← NUEVO

### Frontend (3 archivos nuevos, 2 modificados)
- `frontend/src/app/features/pdf-tools/pdf-tools.component.ts` ← NUEVO
- `frontend/src/app/features/pdf-tools/pdf-tools.component.html` ← NUEVO
- `frontend/src/app/features/pdf-tools/pdf-tools.component.scss` ← NUEVO
- `frontend/src/app/core/services/api.service.ts` ← MODIFICADO
- `frontend/src/app/app.routes.ts` ← MODIFICADO
- `frontend/src/app/app.component.ts` ← MODIFICADO

### Infraestructura (1 modificado)
- `python-worker/Dockerfile` ← MODIFICADO (agregar PyMuPDF)
- `docker-compose.yml` ← VERIFICAR (sin cambios necesarios)

**Total: ~16 archivos** (9 nuevos, 7 modificados)
