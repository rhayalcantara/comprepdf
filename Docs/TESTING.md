# Guía de Pruebas - ComprePDF

Esta guía te ayudará a probar el sistema completo de ComprePDF con Docker.

## Pre-requisitos

1. **Docker Desktop** debe estar instalado y ejecutándose
   - Windows: Asegúrate de que Docker Desktop esté abierto
   - Verifica con: `docker --version` y `docker-compose --version`

2. **Archivo .env** debe existir en la raíz del proyecto
   - Ya fue creado automáticamente desde `.env.example`

## Pasos para Probar el Sistema

### 1. Iniciar Docker Desktop

Asegúrate de que Docker Desktop esté ejecutándose antes de continuar.

### 2. Construir y Levantar los Servicios

```bash
# Detener cualquier contenedor previo (opcional)
docker-compose down -v

# Construir las imágenes y levantar los servicios
docker-compose up --build
```

O en modo detached (segundo plano):
```bash
docker-compose up -d --build
```

### 3. Verificar que los Servicios Estén Corriendo

```bash
docker-compose ps
```

Deberías ver 5 servicios corriendo:
- `comprepdf-mysql` (puerto 3306)
- `comprepdf-redis` (puerto 6379)
- `comprepdf-backend` (puerto 3000)
- `comprepdf-python-worker`
- `comprepdf-frontend` (puerto 4200)

### 4. Verificar los Logs

```bash
# Ver logs de todos los servicios
docker-compose logs -f

# Ver logs de un servicio específico
docker-compose logs -f backend
docker-compose logs -f python-worker
docker-compose logs -f frontend
```

### 5. Probar el Backend (API)

#### Health Check
```bash
curl http://localhost:3000/api/v1/health
```

Respuesta esperada:
```json
{
  "status": "ok",
  "timestamp": "2025-11-21T23:00:00.000Z"
}
```

#### Estadísticas Globales
```bash
curl http://localhost:3000/api/v1/stats
```

Respuesta esperada (puede estar vacía inicialmente):
```json
{
  "success": true,
  "data": {
    "totalJobs": 0,
    "completedJobs": 0,
    "failedJobs": 0,
    "pendingJobs": 0,
    "successRate": 0,
    "avgCompressionRatio": "0",
    "avgProcessingTimeMs": 0,
    "totalOriginalBytes": 0,
    "totalCompressedBytes": 0,
    "totalSpaceSaved": 0,
    "totalCompressions": 0
  }
}
```

#### Comprimir un PDF (requiere archivo PDF de prueba)

Primero, crea o descarga un archivo PDF de prueba. Luego:

```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@test.pdf" \
  -F "compressionLevel=medium"
```

Respuesta esperada:
```json
{
  "success": true,
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "pending",
    "originalFilename": "test.pdf",
    "originalSize": 5242880,
    "compressionLevel": "medium",
    "createdAt": "2025-11-21T23:00:00Z",
    "estimatedTime": 15
  }
}
```

#### Consultar Estado del Trabajo

Usa el `jobId` obtenido en el paso anterior:

```bash
curl http://localhost:3000/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000
```

Respuesta esperada (cuando esté completado):
```json
{
  "success": true,
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "originalFilename": "test.pdf",
    "originalSize": 5242880,
    "compressedSize": 1572864,
    "compressionRatio": 70.0,
    "processingTimeMs": 12500,
    "downloadUrl": "/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000/download",
    "expiresAt": "2025-11-22T23:00:00Z"
  }
}
```

#### Descargar Archivo Comprimido

```bash
curl -O -J http://localhost:3000/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000/download
```

#### Estadísticas Diarias

```bash
curl "http://localhost:3000/api/v1/stats/daily?days=7"
```

#### Trabajos Recientes

```bash
curl "http://localhost:3000/api/v1/stats/recent?limit=10"
```

#### Estadísticas por Nivel de Compresión

```bash
curl http://localhost:3000/api/v1/stats/levels
```

### 6. Probar el Frontend (Angular)

Abre tu navegador en:
```
http://localhost:4200
```

**Flujo de prueba completo:**

1. **Página de Compresión** (`/compress`):
   - Arrastra o selecciona un archivo PDF
   - Elige el nivel de compresión (Baja, Media o Alta)
   - Haz clic en "Comprimir PDF"
   - Observa la barra de progreso
   - Una vez completado, descarga el archivo comprimido
   - Verifica el ratio de compresión

2. **Página de Estadísticas** (`/stats`):
   - Navega a "Estadísticas" en la barra superior
   - Verifica las siguientes secciones:
     - **Estadísticas Globales**: Cards con totales y ratios
     - **Estadísticas Diarias**: Tabla con datos de los últimos 7 días
     - **Distribución por Nivel**: Cards mostrando uso de cada nivel
     - **Trabajos Recientes**: Tabla con últimos 10 trabajos
   - Haz clic en "Actualizar" para refrescar los datos

### 7. Verificar la Base de Datos

```bash
# Conectar a MySQL
docker-compose exec mysql mysql -u comprepdf -pcomprepdf123 comprepdf

# Ver tablas
SHOW TABLES;

# Ver trabajos
SELECT * FROM compression_jobs;

# Ver estadísticas
SELECT * FROM compression_stats;

# Ver archivos
SELECT * FROM files;

# Salir
exit;
```

### 8. Verificar Redis

```bash
# Conectar a Redis
docker-compose exec redis redis-cli

# Ver keys
KEYS *

# Ver info de cola
LLEN bull:compression-queue:wait

# Salir
exit
```

### 9. Verificar el Worker de Python

```bash
# Ver logs del worker
docker-compose logs -f python-worker

# Deberías ver mensajes como:
# [2025-11-21 23:00:00,000: INFO/MainProcess] Connected to redis://redis:6379//
# [2025-11-21 23:00:00,000: INFO/MainProcess] celery@hostname ready.
```

## Pruebas de Diferentes Niveles de Compresión

### Nivel Bajo (72 DPI) - Máxima Compresión
```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@test.pdf" \
  -F "compressionLevel=low"
```

Esperado: ~70-90% de reducción en tamaño

### Nivel Medio (150 DPI) - Balance
```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@test.pdf" \
  -F "compressionLevel=medium"
```

Esperado: ~50-70% de reducción en tamaño

### Nivel Alto (300 DPI) - Mejor Calidad
```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@test.pdf" \
  -F "compressionLevel=high"
```

Esperado: ~20-40% de reducción en tamaño

### Nivel Personalizado
```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@test.pdf" \
  -F "compressionLevel=custom" \
  -F "customDpi=200"
```

## Pruebas de Errores y Validación

### 1. Archivo No-PDF
```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@test.txt" \
  -F "compressionLevel=medium"
```

Esperado: Error 400 "Invalid PDF file format"

### 2. Sin Archivo
```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "compressionLevel=medium"
```

Esperado: Error 400 "File is required"

### 3. Nivel de Compresión Inválido
```bash
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@test.pdf" \
  -F "compressionLevel=invalid"
```

Esperado: Error 400 con mensaje de validación

### 4. Job ID No Existente
```bash
curl http://localhost:3000/api/v1/jobs/non-existent-id
```

Esperado: Error 404 "Job not found"

## Pruebas de Carga (Opcional)

Usar herramientas como Apache Bench o k6:

```bash
# Instalar k6 (si no está instalado)
# Ver: https://k6.io/docs/getting-started/installation/

# Crear archivo de prueba load-test.js:
cat > load-test.js << 'EOF'
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
};

export default function () {
  let res = http.get('http://localhost:3000/api/v1/health');
  check(res, { 'status was 200': (r) => r.status == 200 });
}
EOF

# Ejecutar prueba de carga
k6 run load-test.js
```

## Limpieza Automática de Archivos

El sistema elimina archivos expirados cada hora. Para probar:

1. Comprimir un archivo
2. Verificar que existe en `backend/uploads` y `backend/outputs`
3. Modificar la expiración en MySQL para que esté en el pasado
4. Esperar hasta 1 hora o reiniciar el backend
5. Verificar que los archivos fueron eliminados

```sql
-- Forzar expiración de un archivo
UPDATE files
SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR)
WHERE id = 'your-file-id';
```

## Troubleshooting

### Problema: Contenedores no inician

**Solución:**
```bash
# Ver logs detallados
docker-compose logs

# Reconstruir desde cero
docker-compose down -v
docker-compose build --no-cache
docker-compose up
```

### Problema: MySQL tarda en estar listo

**Solución:**
Esperar a que MySQL esté completamente inicializado. Ver logs:
```bash
docker-compose logs mysql | grep "ready for connections"
```

### Problema: Worker no procesa trabajos

**Solución:**
```bash
# Verificar logs del worker
docker-compose logs python-worker

# Verificar conexión a Redis
docker-compose exec python-worker redis-cli -h redis ping
# Debe responder: PONG

# Verificar que Ghostscript está instalado
docker-compose exec python-worker gs --version
```

### Problema: Frontend no conecta con backend

**Solución:**
- Verificar que backend está escuchando en puerto 3000
- Verificar configuración CORS en backend
- Verificar `environment.ts` en frontend tiene la URL correcta

### Problema: Error "port is already allocated"

**Solución:**
```bash
# Cambiar puertos en docker-compose.yml o
# Detener servicios que usan esos puertos

# Ver qué está usando un puerto
netstat -ano | findstr :3000  # Windows
lsof -i :3000                 # Linux/Mac
```

## Tests Automatizados

### Backend (Jest)
```bash
# Dentro del contenedor o localmente con npm install
docker-compose exec backend npm test

# Con cobertura
docker-compose exec backend npm run test -- --coverage
```

### Python Worker (pytest)
```bash
# Dentro del contenedor
docker-compose exec python-worker pytest

# Con cobertura
docker-compose exec python-worker pytest --cov=app tests/
```

### Frontend (Karma/Jasmine)
```bash
# Dentro del contenedor
docker-compose exec frontend ng test --watch=false

# Tests E2E
docker-compose exec frontend ng e2e
```

## Checklist de Verificación Completa

- [ ] Docker Desktop está ejecutándose
- [ ] Todos los servicios están UP (docker-compose ps)
- [ ] Health check del backend responde OK
- [ ] Frontend carga en http://localhost:4200
- [ ] Se puede comprimir un PDF desde la interfaz
- [ ] El worker procesa el trabajo correctamente
- [ ] Se puede descargar el archivo comprimido
- [ ] Las estadísticas se muestran correctamente
- [ ] Los 4 endpoints de estadísticas funcionan
- [ ] La navegación entre páginas funciona
- [ ] Los logs no muestran errores críticos
- [ ] La base de datos contiene los registros correctos
- [ ] Los archivos se guardan en los directorios correctos
- [ ] La limpieza automática funciona (opcional)
- [ ] Los tests unitarios pasan (opcional)

## Métricas de Éxito

Un sistema completamente funcional debe:

1. **Disponibilidad**: Todos los servicios UP y saludables
2. **Funcionalidad**: Compresión completa de PDF end-to-end
3. **Performance**: Comprimir un PDF de 5MB en <30 segundos
4. **Confiabilidad**: Tasa de éxito >95% en compresiones
5. **Estadísticas**: Datos precisos en todas las consultas
6. **UX**: Interfaz responsiva y feedback claro al usuario

## Detener el Sistema

```bash
# Detener servicios
docker-compose stop

# Detener y eliminar contenedores
docker-compose down

# Detener, eliminar contenedores y volúmenes (limpieza completa)
docker-compose down -v
```

---

¡Listo! Sigue esta guía para probar todo el sistema de ComprePDF de manera exhaustiva.
