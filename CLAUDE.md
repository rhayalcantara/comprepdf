# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ComprePDF is a PDF compression service with a microservices architecture:
- **Frontend**: Angular 17+ with Angular Material and TailwindCSS
- **Backend API**: Node.js + Express + TypeScript + BullMQ
- **Compression Worker**: Python + Celery + Ghostscript + pikepdf
- **Database**: MySQL 8.0 (with TypeORM)
- **Queue/Cache**: Redis 7

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
npm start                         # Run production build
npm test                          # Run all tests
npm run test:watch                # Run tests in watch mode
npm run lint                      # Lint code
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
ng serve                          # Development server (http://localhost:4200)
npm start                         # Alias for ng serve
ng build --configuration=production  # Production build
ng test                           # Unit tests with Karma/Jasmine
ng lint                           # Lint code
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

### Core Endpoints
```
POST   /api/v1/compress              # Upload and compress PDF
GET    /api/v1/jobs/:jobId           # Get job status
GET    /api/v1/jobs/:jobId/download  # Download compressed PDF
DELETE /api/v1/jobs/:jobId           # Delete job
GET    /api/v1/health                # Health check
```

### Statistics Endpoints
```
GET    /api/v1/stats                 # Global statistics (totals, ratios, averages)
GET    /api/v1/stats/daily?days=7    # Daily statistics (default: 7 days)
GET    /api/v1/stats/recent?limit=10 # Recent jobs (default: 10)
GET    /api/v1/stats/levels          # Statistics by compression level
```

## Compression Levels

- `low` (screen): 72 DPI, 70-90% reduction
- `medium` (ebook): 150 DPI, 50-70% reduction
- `high` (printer): 300 DPI, 20-40% reduction
- `custom`: User-defined DPI

## Key Constraints

- Max file size: 50MB (configurable via `MAX_FILE_SIZE_MB`)
- Files expire after 24 hours (configurable via `FILE_EXPIRY_HOURS`)
- Files cleaned up automatically every hour
- Ghostscript must run with `-dSAFER` flag for security
- All PDF validation must check magic bytes (%PDF-)

## Database Schema

Three main tables:
- `compression_jobs` - Job tracking (status, compression_level, timestamps)
- `files` - File metadata (original/compressed, paths, sizes, expiration)
- `compression_stats` - Analytics (ratios, processing time, pages, images)

All jobs use UUID v4 as primary keys. Files cascade delete when jobs are deleted.

## Environment Variables

### Backend
```env
NODE_ENV=development|production
PORT=3000
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_DATABASE=comprepdf
MYSQL_USER=comprepdf
MYSQL_PASSWORD=comprepdf123
REDIS_HOST=localhost
REDIS_PORT=6379
MAX_FILE_SIZE_MB=50
FILE_EXPIRY_HOURS=24
```

### Python Worker
```env
MYSQL_HOST=localhost
REDIS_HOST=localhost
UPLOAD_DIR=/app/uploads
OUTPUT_DIR=/app/outputs
```

## Debugging & Troubleshooting

### View Logs
```bash
docker-compose logs -f              # All services
docker-compose logs -f backend      # Backend only
docker-compose logs -f python-worker  # Worker only
docker-compose logs --tail=100 backend  # Last 100 lines
```

### Database Access
```bash
# Connect to MySQL
docker-compose exec mysql mysql -u comprepdf -pcomprepdf123 comprepdf

# Common queries
SELECT * FROM compression_jobs ORDER BY created_at DESC LIMIT 10;
SELECT * FROM compression_stats;
SELECT COUNT(*) FROM files WHERE expires_at < NOW();  # Expired files
```

### Redis Inspection
```bash
# Connect to Redis CLI
docker-compose exec redis redis-cli

# Useful commands
KEYS *                              # List all keys
LLEN bull:compression-queue:wait    # Queue length
GET <key>                           # Get value
```

### Service Health Checks
```bash
# Verify services are running
docker-compose ps

# Check backend health
curl http://localhost:3000/api/v1/health

# Verify Ghostscript in worker
docker-compose exec python-worker gs --version

# Check database connectivity
docker-compose exec backend npx typeorm query "SELECT 1"
```

### Common Issues

**Worker not processing jobs:**
- Check `docker-compose logs python-worker` for errors
- Verify Redis connection: `docker-compose exec python-worker redis-cli -h redis ping`
- Ensure Celery is running: look for "celery@hostname ready" in logs

**Frontend can't reach backend:**
- Verify backend is on port 3000: `curl http://localhost:3000/api/v1/health`
- Check CORS settings in backend
- Verify `environment.ts` has correct API URL

**MySQL not ready:**
- Wait for "ready for connections" in logs: `docker-compose logs mysql | grep "ready for connections"`
- MySQL takes ~30 seconds to initialize on first run

## Testing

See [TESTING.md](./TESTING.md) for comprehensive testing guide.

### Quick Test Commands
```bash
# Backend tests
docker-compose exec backend npm test
docker-compose exec backend npm run test:watch

# Python worker tests
docker-compose exec python-worker pytest
docker-compose exec python-worker pytest --cov=app tests/

# Frontend tests
docker-compose exec frontend ng test --watch=false
```
