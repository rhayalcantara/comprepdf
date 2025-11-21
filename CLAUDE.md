# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ComprePDF is a PDF compression service with a microservices architecture:
- **Frontend**: Angular 17+ with Angular Material and TailwindCSS
- **Backend API**: Node.js + Express + TypeScript
- **Compression Worker**: Python + Celery + Ghostscript
- **Database**: MySQL 8.0
- **Queue/Cache**: Redis

## Architecture

```
Angular (4200) → Node.js API (3000) → Redis Queue → Python Worker (8000)
                       ↓                                    ↓
                    MySQL ←─────────────────────────────────┘
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
GET    /api/v1/jobs/:jobId           # Get job status
GET    /api/v1/jobs/:jobId/download  # Download compressed PDF
DELETE /api/v1/jobs/:jobId           # Delete job
GET    /api/v1/health                # Health check
```

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
