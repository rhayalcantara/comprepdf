# ComprePDF - Servicio de Compresión de PDF

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Servicio web profesional para comprimir archivos PDF con diferentes niveles de calidad, optimizado para procesamiento asíncrono y escalabilidad.

## 📋 Tabla de Contenidos

- [Características](#-características)
- [Stack Tecnológico](#-stack-tecnológico)
- [Arquitectura](#-arquitectura)
- [Requisitos](#-requisitos)
- [Instalación](#-instalación)
- [Uso](#-uso)
- [API Reference](#-api-reference)
- [Desarrollo](#-desarrollo)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Troubleshooting](#-troubleshooting)

## ✨ Características

- 🚀 **Procesamiento Asíncrono**: Sistema de colas con Celery y Redis
- 🎯 **Múltiples Niveles de Compresión**: Low (72 DPI), Medium (150 DPI), High (300 DPI), Custom
- 📊 **Análisis de PDFs**: Extracción de metadata, conteo de páginas e imágenes
- 🔒 **Seguridad**: Validación de archivos, rate limiting, sanitización de inputs
- 🧹 **Limpieza Automática**: Eliminación de archivos expirados (24h)
- 📈 **Estadísticas**: Tracking de compresiones, ratios y tiempos de procesamiento
- 🎨 **Interfaz Moderna**: Angular 17 con Material Design
- 🐳 **Containerizado**: Docker Compose para desarrollo y producción

## 🛠 Stack Tecnológico

### Backend
- **Node.js 20** + **Express** + **TypeScript** - API REST
- **TypeORM** - ORM para MySQL
- **BullMQ** - Sistema de colas
- **Winston** - Logging estructurado
- **Jest** - Testing framework

### Worker de Compresión
- **Python 3.11** - Motor de compresión
- **Celery** - Workers distribuidos
- **Ghostscript** - Compresión de PDFs
- **pikepdf** - Manipulación y análisis de PDFs
- **Pillow** - Optimización de imágenes

### Frontend
- **Angular 17** - Framework SPA
- **Angular Material** - Componentes UI
- **TailwindCSS** - Estilos utility-first
- **RxJS** - Programación reactiva

### Infraestructura
- **MySQL 8.0** - Base de datos relacional
- **Redis 7** - Cache y cola de mensajes
- **Docker** + **Docker Compose** - Containerización
- **Nginx** - Reverse proxy

## 🏗 Arquitectura

```
┌─────────────────┐
│     Nginx       │
│ (Reverse Proxy) │
└────────┬────────┘
         │
    ┌────┼────┐
    │    │    │
    ▼    ▼    ▼
┌──────┐ ┌──────┐ ┌──────────┐
│Angular│ │Node.js│ │  Python  │
│  App  │ │  API  │ │  Worker  │
└───────┘ └───┬───┘ └────┬─────┘
              │          │
         ┌────┴────┐    │
         │         │    │
         ▼         ▼    ▼
     ┌─────┐   ┌─────────┐
     │MySQL│   │  Redis  │
     └─────┘   └─────────┘
```

### Flujo de Compresión

1. Usuario sube PDF → Angular Frontend
2. Frontend → Node.js API (validación + almacenamiento)
3. API crea job en MySQL → encola en Redis
4. Python Worker consume job de Redis
5. Worker comprime PDF con Ghostscript
6. Worker actualiza MySQL con resultado
7. Usuario descarga PDF comprimido

## 📦 Requisitos

### Desarrollo con Docker (Recomendado)
- Docker 24.0+
- Docker Compose 2.0+

### Desarrollo Local
- Node.js 20+
- Python 3.11+
- MySQL 8.0+
- Redis 7+
- Ghostscript 10.0+

## 🚀 Instalación

### Opción 1: Docker Compose (Recomendado)

1. **Clonar el repositorio**
```bash
git clone <repository-url>
cd comprepdf
```

2. **Configurar variables de entorno**
```bash
cp .env.example .env
```

Editar `.env` si es necesario:
```env
MYSQL_ROOT_PASSWORD=rootpassword
MYSQL_USER=comprepdf
MYSQL_PASSWORD=comprepdf123
MYSQL_DATABASE=comprepdf
```

3. **Iniciar servicios**
```bash
docker-compose up -d
```

4. **Verificar que los servicios están corriendo**
```bash
docker-compose ps
```

Deberías ver 5 contenedores running:
- `comprepdf-mysql`
- `comprepdf-redis`
- `comprepdf-backend`
- `comprepdf-python-worker`
- `comprepdf-frontend`

5. **Acceder a la aplicación**
- Frontend: http://localhost:4200
- API Health: http://localhost:3000/api/v1/health
- MySQL: localhost:3306
- Redis: localhost:6379

### Opción 2: Desarrollo Local

#### Backend

```bash
cd backend
npm install
npm run dev
```

Variables de entorno requeridas (`.env`):
```env
NODE_ENV=development
PORT=3000
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_DATABASE=comprepdf
MYSQL_USER=comprepdf
MYSQL_PASSWORD=comprepdf123
REDIS_HOST=localhost
REDIS_PORT=6379
```

#### Python Worker

```bash
cd python-worker
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
celery -A app.workers.compression_worker worker --loglevel=info
```

**Importante**: Asegúrate de tener Ghostscript instalado:
- macOS: `brew install ghostscript`
- Ubuntu: `sudo apt-get install ghostscript`
- Windows: Descargar desde https://www.ghostscript.com/

#### Frontend

```bash
cd frontend
npm install
ng serve
```

Acceder a http://localhost:4200

## 💡 Uso

### Desde la Interfaz Web

1. Acceder a http://localhost:4200
2. Arrastrar o seleccionar un archivo PDF
3. Elegir nivel de compresión:
   - **Baja (72 DPI)**: Máxima compresión para pantallas
   - **Media (150 DPI)**: Balance recomendado para lectura digital
   - **Alta (300 DPI)**: Mejor calidad para impresión
4. Hacer clic en "Comprimir PDF"
5. Esperar procesamiento (se muestra progreso)
6. Descargar archivo comprimido

### Desde la API

#### Comprimir un PDF

```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@documento.pdf" \
  -F "compressionLevel=medium"
```

Respuesta:
```json
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

#### Consultar estado del trabajo

```bash
curl http://localhost:3000/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000
```

Respuesta:
```json
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
    "expiresAt": "2025-11-22T10:30:00Z"
  }
}
```

#### Descargar PDF comprimido

```bash
curl -O -J http://localhost:3000/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000/download
```

## 📚 API Reference

### Endpoints

| Método | Endpoint | Descripción | Body/Params |
|--------|----------|-------------|-------------|
| POST | `/api/v1/compress` | Comprimir PDF | `file`, `compressionLevel`, `preserveMetadata`, `customDpi` |
| GET | `/api/v1/jobs/:jobId` | Estado del trabajo | - |
| GET | `/api/v1/jobs/:jobId/download` | Descargar comprimido | - |
| DELETE | `/api/v1/jobs/:jobId` | Eliminar trabajo | - |
| GET | `/api/v1/stats` | Estadísticas globales | - |
| GET | `/api/v1/stats/daily` | Estadísticas diarias | `days` (default: 7) |
| GET | `/api/v1/stats/recent` | Trabajos recientes | `limit` (default: 10) |
| GET | `/api/v1/stats/levels` | Estadísticas por nivel | - |
| GET | `/api/v1/health` | Health check | - |

### Niveles de Compresión

| Nivel | DPI | Reducción | Caso de Uso |
|-------|-----|-----------|-------------|
| `low` | 72 | 70-90% | Visualización en pantalla, email |
| `medium` | 150 | 50-70% | Lectura digital, eBooks |
| `high` | 300 | 20-40% | Impresión, archivo |
| `custom` | Personalizado | Variable | Requiere `customDpi` (50-600) |

### Códigos de Estado

- `200` - OK
- `201` - Created (nuevo job)
- `400` - Bad Request (validación fallida)
- `404` - Not Found (job o archivo no encontrado)
- `429` - Too Many Requests (rate limit excedido)
- `500` - Internal Server Error

## 🔧 Desarrollo

### Comandos Útiles

```bash
# Ver logs de todos los servicios
docker-compose logs -f

# Ver logs de un servicio específico
docker-compose logs -f backend

# Reiniciar servicios
docker-compose restart

# Detener servicios
docker-compose down

# Detener y eliminar volúmenes
docker-compose down -v

# Reconstruir imágenes
docker-compose build --no-cache
```

### Estructura del Proyecto

```
comprepdf/
├── backend/
│   ├── src/
│   │   ├── config/          # Configuraciones (DB, Redis)
│   │   ├── controllers/     # Controladores de rutas
│   │   ├── models/          # Modelos TypeORM
│   │   ├── services/        # Lógica de negocio
│   │   ├── middlewares/     # Middlewares (validación, errores)
│   │   └── utils/           # Utilidades y helpers
│   ├── tests/               # Tests unitarios e integración
│   └── package.json
│
├── python-worker/
│   ├── app/
│   │   ├── compression/     # Lógica de compresión
│   │   │   ├── ghostscript.py
│   │   │   └── pdf_analyzer.py
│   │   └── workers/         # Celery workers
│   └── requirements.txt
│
├── frontend/
│   ├── src/app/
│   │   ├── core/            # Servicios singleton
│   │   ├── features/        # Módulos de features
│   │   └── shared/          # Componentes compartidos
│   └── package.json
│
└── database/
    └── schema.sql           # Esquema de base de datos
```

## 🧪 Testing

**Para una guía completa de pruebas del sistema, ver [TESTING.md](./TESTING.md)**

### Backend (Node.js)

```bash
cd backend

# Ejecutar todos los tests
npm test

# Tests en modo watch
npm run test:watch

# Tests con cobertura
npm run test -- --coverage
```

### Python Worker

```bash
cd python-worker

# Ejecutar tests
pytest

# Tests con cobertura
pytest --cov=app tests/
```

### Frontend (Angular)

```bash
cd frontend

# Tests unitarios
ng test

# Tests E2E
ng e2e
```

## 🚢 Deployment

### Producción con Docker

1. **Crear archivo de producción**
```bash
cp docker-compose.yml docker-compose.prod.yml
```

2. **Editar configuraciones de producción**
- Cambiar contraseñas
- Configurar dominios
- Ajustar recursos (CPU, RAM)

3. **Deploy**
```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Variables de Entorno Importantes

```env
NODE_ENV=production
MAX_FILE_SIZE_MB=50
FILE_EXPIRY_HOURS=24
REDIS_HOST=redis
MYSQL_HOST=mysql
```

### Configurar Nginx (Reverse Proxy)

Ver `nginx/nginx.conf` para configuración de ejemplo.

## 🔍 Troubleshooting

### Los servicios no inician

```bash
# Verificar logs
docker-compose logs

# Verificar estado de contenedores
docker-compose ps

# Reiniciar servicios
docker-compose restart
```

### Error de conexión a MySQL

```bash
# Verificar que MySQL está corriendo
docker-compose ps mysql

# Esperar a que MySQL esté listo
docker-compose logs mysql | grep "ready for connections"
```

### Worker de Python no procesa trabajos

```bash
# Verificar logs del worker
docker-compose logs python-worker

# Verificar conexión a Redis
docker-compose exec python-worker redis-cli -h redis ping
```

### Archivos no se eliminan automáticamente

El servicio de limpieza ejecuta cada hora. Para forzar limpieza:

```bash
docker-compose restart backend
```

### Error "Ghostscript not found"

Asegúrate de que Ghostscript está instalado:

```bash
# En el contenedor
docker-compose exec python-worker gs --version

# En desarrollo local
gs --version
```

## 📊 Monitoreo

### Métricas Disponibles

- Número de compresiones por día
- Ratio promedio de compresión
- Tiempo promedio de procesamiento
- Tasa de errores
- Uso de almacenamiento

### Logs

Los logs se almacenan en:
- Backend: stdout (capturado por Docker)
- Python Worker: stdout (capturado por Docker)
- MySQL: `/var/lib/mysql/*.log`

## 🤝 Contribución

1. Fork el proyecto
2. Crear rama feature (`git checkout -b feature/AmazingFeature`)
3. Commit cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abrir Pull Request

## 📄 Licencia

MIT License - ver el archivo LICENSE para detalles

## 👥 Soporte

Para reportar bugs o solicitar features, abrir un issue en el repositorio.

---

Desarrollado con ❤️ usando Angular, Node.js y Python
