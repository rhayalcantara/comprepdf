# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ComprePDF is a PDF service (compression + operations) with a microservices architecture:
- **Frontend**: Angular 17+ with Angular Material and TailwindCSS
- **Backend API**: Node.js + Express + TypeScript
- **PDF Worker**: Python + Ghostscript (compress) + pikepdf (split/merge/extract/rotate/organize/protect/unlock) + pyHanko (digital signature) + Office COM vía pywin32 (convert; requiere Microsoft Office en el host del worker — QA tiene Office 2010) + pdf2docx (pdf_to_word) + PyMuPDF find_tables + openpyxl (pdf_to_excel)
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

### Docker (recommended for development)
```bash
docker-compose up -d              # Start all services
docker-compose logs -f backend    # View backend logs
docker-compose down               # Stop all services
```

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
- `frontend/src/app/features/` - Angular feature modules (login, tools, jobs, users, …)
- `frontend/src/app/core/` - singleton services, guards, interceptors (auth, API)

## Authentication & ownership

Every route requires a JWT (`Authorization: Bearer <token>`) **except three public
routes**: `GET /api/v1/health`, `POST /api/v1/auth/login` and
`POST /api/v1/auth/register`. Enforcement is centralized in `routes/index.ts`
(`router.use(requireAuth)` after the public routes); `requireRole('admin')` guards
the admin-only routes.

- JWT HS256, 8h expiry, `JWT_SECRET` env (fail-closed: no secret → login blocked).
  Payload `{ sub: userId, rol }`. Roles: `admin` and `user`.
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

## API Endpoints

```
# Auth (login/register are public; the rest need a token)
POST   /api/v1/auth/login            # { username, password } -> { token, user }
POST   /api/v1/auth/register         # self-registration (domain-restricted) -> pending user
GET    /api/v1/auth/me               # current user profile
POST   /api/v1/auth/change-password  # change own password

# Users (admin only; no physical delete — baja = estado 'inactivo')
GET    /api/v1/users                 # list users
POST   /api/v1/users                 # create user (returns one-time temp password)
PATCH  /api/v1/users/:id             # edit rol/estado (activate pending) / reset password

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

## Key Constraints

- Max file size: 50MB (configurable)
- Files expire after 24 hours
- Ghostscript must run with `-dSAFER` flag for security
- All PDF validation must check magic bytes (%PDF-)
