# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ComprePDF is a PDF service (compression + operations) with a microservices architecture:
- **Frontend**: Angular 17+ with Angular Material and TailwindCSS
- **Backend API**: Node.js + Express + TypeScript
- **PDF Worker**: Python + Ghostscript (compress) + pikepdf (split/merge/extract/rotate/protect/unlock) + pyHanko (digital signature)
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
- `python-worker/app/compression/` - PDF compression logic (Ghostscript wrapper)
- `python-worker/app/workers/` - Celery tasks
- `frontend/src/app/features/` - Angular feature modules
- `frontend/src/app/core/services/` - Singleton services (API, compression)

## API Endpoints

```
POST   /api/v1/compress              # Upload and compress PDF
POST   /api/v1/pdf/split             # Split into pages/ranges (returns a ZIP)
POST   /api/v1/pdf/merge             # Merge multiple PDFs (field: files[])
POST   /api/v1/pdf/sign              # Digital signature (fields: file, cert .pfx; body: password)
POST   /api/v1/pdf/extract           # Extract pages (body: pages, e.g. "1-3,5")
POST   /api/v1/pdf/rotate            # Rotate pages (body: degrees, pages)
POST   /api/v1/pdf/protect           # Add password (body: password)
POST   /api/v1/pdf/unlock            # Remove password (body: password)
GET    /api/v1/jobs/:jobId           # Get job status (any operation)
GET    /api/v1/jobs/:jobId/download  # Download result (any operation)
DELETE /api/v1/jobs/:jobId           # Delete job
GET    /api/v1/health                # Health check
```

New operations follow one pattern: controller inserts a `compression_jobs` row
(`operation_type` + `operation_params` JSON) and original file(s); the poller
dispatches to `python-worker/app/operations/` and writes an `output` file row.

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
