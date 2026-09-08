# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ComprePDF is a PDF service (compression + operations) with a microservices architecture:
- **Frontend**: Angular 17+ with Angular Material and TailwindCSS
- **Backend API**: Node.js + Express + TypeScript
- **PDF Worker**: Python + Ghostscript (compress) + pikepdf (split/merge/extract/rotate/organize/protect/unlock) + pyHanko (digital signature) + Office COM vía pywin32 (convert; requiere Microsoft Office en el host del worker — QA tiene Office 2010) + pdf2docx (pdf_to_word) + PyMuPDF find_tables + openpyxl (pdf_to_excel) + PyMuPDF/Ollama (translate; LLM local en 192.168.2.165:11434)
- **Database**: MySQL 8.0
- **Cache**: Redis

> **Job delivery**: the worker is a **MySQL polling loop** (`python-worker/app/workers/poller.py`),
> not a message broker. The backend inserts a `compression_jobs` row with
> `status='pending'` and `operation_type`; the poller claims it with
> `SELECT ... FOR UPDATE SKIP LOCKED` and dispatches to a handler in
> `app/operations/`. (BullMQ and Celery were removed — they were mutually
> incompatible and delivered nothing.)

## Architecture

```
Angular (4200) → Node.js API (3000) → MySQL ← (poll) Python Worker
                                         ↑                  │
                                         └── writes output ─┘
     (uploads_data / outputs_data son volúmenes compartidos)
```

## Common Commands

### Docker
```bash
docker compose -f docker-compose.dev.yml up -d   # DESARROLLO (bind mounts, hot-reload)
docker compose up -d --build                     # PRODUCCIÓN/qa (lo que ejecuta el Puente)
docker compose logs -f backend
```

**`docker-compose.yml` es el de PRODUCCIÓN** y `docker-compose.dev.yml` el de
desarrollo. No es un capricho: producción (192.168.113.20, Ubuntu + Compose) se
despliega con el **Puente** (MCP `puente`, proyecto `C:\Claude\Proyectos\PuenteDespliegue`),
cuya secuencia es fija y sin opciones — `git checkout main` → `compose config -q`
→ `compose build` → `compose up -d` — así que no admite `-f` ni profiles, y un
`docker-compose.override.yml` versionado se aplicaría solo en producción (nunca
crear uno). Ningún agente recibe SSH: se pide `desplegar(comprepdf, produccion)`
y una persona confirma. Reglas que impone:

- **Un solo puerto** publicado (`COMPREPDF_PORT`, 3060 en producción): nginx del
  frontend sirve la SPA y proxea `/api` al backend; el build de producción usa
  `apiUrl: '/api/v1'` (relativo, `environment.prod.ts`). MySQL/Redis no se publican.
- **Configuración solo por `.env`** (plantilla `.env.example`, `env_file` en
  todos los servicios). **No repetir en `environment:` claves del `.env`**: lo de
  `environment:` gana y lo anula en silencio.
- **El Puente no ejecuta SQL.** Las migraciones de `database/migrations` las
  aplica **el backend al arrancar** (`services/migration.service.ts`, tabla
  `schema_migrations`, idempotente: baseline si el esquema ya está al día,
  tolera "ya existe", cualquier otro error impide arrancar). `schema.sql` solo
  vale para el primer arranque (initdb). Nueva migración = nuevo `NNN_x.sql` y
  reflejarla también en `schema.sql`.
- **El backend migra antes de abrir el puerto** y el worker arranca solo cuando
  el backend está `healthy`: nunca hay worker nuevo sobre esquema viejo.
- **`convert` en Linux usa LibreOffice** dentro de la imagen del worker
  (`converters/office_libre.py`); en Windows (QA nativo) sigue COM de Office.
  `converters/office.py` elige el motor (`OFFICE_ENGINE` fuerza uno).
- El qa del catálogo del Puente vive en la DGX Spark 192.168.2.165 (ARM64): las
  imágenes se construyen en cada host, nunca se copian entre máquinas.


### Backend (Node.js)
```bash
cd backend
npm install
npm run dev                       # Development with hot-reload
npm run build                     # Build for production
npm test                          # Run tests
npm run test:watch                # Run single test in watch mode
```

### Python Worker
```bash
cd python-worker
pip install -r requirements.txt
celery -A app.workers.compression_worker worker --loglevel=info
pytest                            # Run tests
pytest tests/test_compression.py -k "test_name"  # Run single test
```

### Frontend (Angular)
```bash
cd frontend
npm install
ng serve                          # Development server
ng build --configuration=production
ng test                           # Unit tests
ng e2e                            # E2E tests
```

### Database
```bash
# Initialize schema
mysql -u root -p comprepdf < database/schema.sql
```

## Project Structure

- `backend/src/controllers/` - API route handlers
- `backend/src/services/` - Business logic
- `backend/src/models/` - TypeORM entities for MySQL
- `python-worker/app/operations/` - operation handlers (compress, pdf_ops, sign, certificate)
- `python-worker/app/workers/poller.py` - MySQL polling loop (claims & dispatches jobs)
- `frontend/src/app/features/` - Angular feature modules (login, tools, estudio, jobs, users, …)
- `frontend/src/app/core/` - singleton services, guards, interceptors (auth, API)
- `frontend/src/app/shared/pdf-markup/` - **el único** visor con capa de edición
  (lienzo + panel de propiedades + modelo de elementos). Lo usan `/editor` y el
  Estudio; no crear un segundo visor.

## El Estudio (`/estudio`)

Espacio de trabajo único donde el documento es el centro y las operaciones son
verbos que se ejercen sobre él, en vez de 15 herramientas con su propia subida y
su propia descarga. Ver `Docs/PLAN_ESTUDIO_PDF.md`.

**Encadenado de jobs.** Toda operación acepta, además de un archivo subido, la
**salida de un job anterior**: `sourceJobId` en el cuerpo. `resolveSourceJob`
(`middlewares/source-job.middleware.ts`) va entre el multer y la validación, y
deja `req.file` puesto venga de donde venga — controladores y `validatePdfFile`
no distinguen los dos casos, y **el worker no se entera**. Ownership idéntico al
de la descarga: job ajeno u huérfano → 404. Solo se encadena sobre PDF (un ZIP de
split o un .docx no se siguen editando). `merge` usa `sources` (array ordenado de
`{jobId}` / `{upload:i}`) para insertar páginas en medio del documento abierto.

**Sesiones.** `compression_jobs.session_id` agrupa la cadena y `parent_job_id`
dice de qué job salió la entrada. "Mis trabajos" muestra **un renglón por
sesión** (el último paso; ver `LATEST_OF_SESSION` en `models/job.model.ts`), y
`cleanup.service.ts` purga los pasos ya superados pasado
`INTERMEDIATE_JOB_TTL_MINUTES` (120 por defecto; el TTL es lo que permite
deshacer).

**Edición diferida (frontend).** `features/estudio/workspace.service.ts` mantiene
los cambios en memoria y solo habla con el servidor en los puntos de *flush*
(exportar, descargar, o pulsar Aplicar). Varios cambios del mismo tipo se funden
en UN job: reordenar+girar+eliminar → un `organize`; todo el marcado → un
`pdf_edit`. **Invariante:** nunca hay pendientes de dos tipos a la vez —
`ensureKind` materializa lo anterior al cambiar de tipo. Sin ella, un resaltado
hecho antes de mover una página acabaría en la página equivocada, porque
`MarkupElement.page` es la posición VISIBLE.

## Authentication & ownership

Every route requires a JWT (`Authorization: Bearer <token>`) **except three public
routes**: `GET /api/v1/health`, `POST /api/v1/auth/login` and
`POST /api/v1/auth/register`. Enforcement is centralized in `routes/index.ts`
(`router.use(requireAuth)` after the public routes); `requireRole('admin')` guards
the admin-only routes.

- JWT HS256, 8h expiry, `JWT_SECRET` env (fail-closed: no secret → login blocked).
  Payload `{ sub: userId, rol }`. Roles: `admin` and `user`.
- El campo `username` del login acepta **el nombre de usuario o el correo**: se
  busca por username y, si no casa ninguna cuenta, por email (ambas columnas son
  case-insensitive; el username manda si coincide). Las altas manuales dejaron
  cuentas cuyo dueño no acierta a teclear su propio nombre (con espacios, o el
  correo entero como username), y el 401 genérico les hace creer que falla la
  contraseña: la resetean una y otra vez sin efecto. Por lo mismo `username` es
  editable desde `PATCH /users/:id` (único; los jobs cuelgan de `user_id`, así
  que renombrar no toca el historial).
- Jobs are owned (`compression_jobs.user_id`): a user only sees/downloads/deletes
  **their own** jobs — someone else's or an orphan (`user_id NULL`) returns **404**
  (not 403, to avoid revealing existence). Admin sees all.
- Downloads require the auth header, so the frontend fetches them as a **blob**
  (no direct `<a href>`).
- The certificate module requires role `admin` (the old `X-Admin-Key` was removed).
- Self-registration creates users in `estado='pendiente'` (login blocked) restricted
  to the `ALLOWED_SIGNUP_DOMAIN` email domain; an admin activates them via `PATCH`.
- First admin is seeded at backend startup from `ADMIN_INITIAL_PASSWORD`
  (with `must_change_password`); see `models/user.model.ts` `seedInitialAdmin`.
  No siembra si existe el usuario `admin` **ni si ya hay cualquier admin activo**
  — como el username es editable, buscar solo 'admin' resucitaría un segundo
  administrador con la contraseña del `.env` en cuanto renombraran al primero.

## API Endpoints

```
# Auth (login/register are public; the rest need a token)
POST   /api/v1/auth/login            # { username, password } -> { token, user }; `username` = usuario O correo
POST   /api/v1/auth/register         # self-registration (domain-restricted) -> pending user
GET    /api/v1/auth/me               # current user profile
POST   /api/v1/auth/change-password  # change own password

# Users (admin only; no physical delete — baja = estado 'inactivo')
GET    /api/v1/users                 # list users
POST   /api/v1/users                 # create user (returns one-time temp password)
PATCH  /api/v1/users/:id             # edit username/nombre/email/rol/estado (activate pending) / reset password

# PDF operations (create a job owned by the caller)
POST   /api/v1/compress              # Upload and compress PDF
POST   /api/v1/pdf/split             # Split into pages/ranges (returns a ZIP)
POST   /api/v1/pdf/merge             # Merge multiple PDFs (field: files[]; optional pageRanges[] per file)
POST   /api/v1/pdf/sign              # Sign: mode certificate (.pfx) | drawn (image) | combined
POST   /api/v1/pdf/extract           # Extract pages (body: pages, e.g. "1-3,5")
POST   /api/v1/pdf/rotate            # Rotate pages (body: degrees, pages)
POST   /api/v1/pdf/organize          # Reorder/delete/rotate pages (body: pages JSON [{source,rotate}])
POST   /api/v1/pdf/convert           # Office/txt/rtf/image -> PDF (file field; Office via COM on worker host)
POST   /api/v1/pdf/to-word           # PDF -> Word .docx editable (pdf2docx; rechaza cifrados/escaneados)
POST   /api/v1/pdf/to-excel          # PDF -> Excel .xlsx: extrae TABLAS (una hoja por tabla; sin tablas -> error)
POST   /api/v1/pdf/translate         # Traducir PDF (body: targetLang es|en|fr|pt|it|de) via LLM local (Ollama, OLLAMA_URL/OLLAMA_MODEL en el worker); mantiene el diseño
POST   /api/v1/pdf/protect           # Add password (body: password)
POST   /api/v1/pdf/unlock            # Remove password (body: password)
POST   /api/v1/certificates          # (admin) Issue internal .pfx certificate

# PDF forms (definiciones persistentes de formularios rellenables, con ownership)
GET    /api/v1/forms                 # my form definitions (admin: all)
POST   /api/v1/forms                 # create a form definition
GET    /api/v1/forms/:id             # get a definition (owner or admin, else 404)
PUT    /api/v1/forms/:id             # update a definition (bumps version)
DELETE /api/v1/forms/:id             # delete a definition
POST   /api/v1/forms/:id/generate    # generate the fillable PDF (creates a form_generate job)
POST   /api/v1/forms/preview         # generate a PDF from a definition WITHOUT persisting it

# Jobs
GET    /api/v1/jobs                  # my jobs, paginated (admin: ?all=true adds username)
GET    /api/v1/jobs/:jobId           # Get job status (owner or admin, else 404)
GET    /api/v1/jobs/:jobId/download  # Download result (owner or admin; blob, needs token)
DELETE /api/v1/jobs/:jobId           # Delete job (owner or admin)
GET    /api/v1/health                # Health check (public)
```

Todas las operaciones sobre PDF aceptan además `sourceJobId` (encadenar sobre la
salida de otro job, sin descarga intermedia) y `sessionId` (agrupar la cadena).
Ver "El Estudio" más arriba.

New operations follow one pattern: controller inserts a `compression_jobs` row
(`operation_type` + `operation_params` JSON) and original file(s); the poller
dispatches to `python-worker/app/operations/` and writes an `output` file row.

**Form generation is the one exception with NO input file**: `form_generate`
(handler `app/operations/form_generate.py`, reportlab-based) renders a fillable
AcroForm PDF from `operation_params.definition`. Form definitions themselves are
persistent (table `pdf_forms`, entity `PdfForm`, ownership like jobs) and edited
via the `/forms` CRUD; only the actual PDF render goes through the job/poller
flow. The Angular editor lives in `frontend/src/app/features/forms/`.

All operations (including compress) accept an optional `outputName` body field:
the user-chosen name for the result file (extension added automatically; for
split it names the ZIP and the per-part prefix). Sanitized in the backend
(`utils/filename.ts`) and again in the worker (`common.custom_basename`).

## Compression Levels

- `low` (screen): 72 DPI, 70-90% reduction
- `medium` (ebook): 150 DPI, 50-70% reduction
- `high` (printer): 300 DPI, 20-40% reduction
- `custom`: User-defined DPI

Esos porcentajes valen para PDF **con imágenes**, que es lo que Ghostscript
remuestrea. En un PDF de solo texto vectorial no hay nada que reducir: el ahorro
cae a ~5-10% y `high` puede incluso **agrandar** el archivo al reescribirlo
(medido en QA: 35 KB → 55 KB). No es un fallo; es lo que hace `pdfwrite`.

## Ghostscript (requisito del host del worker)

`compress` es la única operación que necesita un binario externo. El worker lo
localiza con `resolve_ghostscript()` (`app/compression/ghostscript.py`):
`GHOSTSCRIPT_PATH` si está definida → `gswin64c`/`gswin32c` en Windows → `gs`.

**En Windows el ejecutable NO se llama `gs`** — asumirlo tuvo la compresión rota
en QA desde siempre, y el síntoma (`[WinError 2] The system cannot find the file
specified`) no menciona a Ghostscript. Si falta, el error del job ahora lo dice y
sugiere `GHOSTSCRIPT_PATH`.

## Key Constraints

- Max file size: 50MB (configurable)
- Files expire after 24 hours
- Ghostscript must run with `-dSAFER` flag for security
- All PDF validation must check magic bytes (%PDF-)
