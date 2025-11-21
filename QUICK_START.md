# Guía de Inicio Rápido - ComprePDF

## 🚀 Pasos para Probar el Sistema

### Paso 1: Iniciar Docker Desktop

**⚠️ IMPORTANTE: Debes iniciar Docker Desktop primero**

1. Abre **Docker Desktop** desde el menú de Windows
2. Espera a que el icono de Docker en la barra de tareas muestre "Docker Desktop is running"
3. Verifica que está corriendo ejecutando:

```bash
docker info
```

Si ves información del servidor, Docker está listo. Si ves un error, espera unos segundos más.

---

### Paso 2: Iniciar Todos los Servicios

Desde la carpeta del proyecto (`C:\Proyectos\comprepdf`), ejecuta:

```bash
docker-compose up --build
```

**Esto iniciará 5 servicios:**
- ✅ MySQL (base de datos)
- ✅ Redis (cola de mensajes)
- ✅ Backend (Node.js API)
- ✅ Python Worker (procesador de PDFs)
- ✅ Frontend (Angular)

**Espera aproximadamente 2-3 minutos** para que todos los servicios inicien correctamente.

Verás logs como:
```
comprepdf-mysql     | ready for connections
comprepdf-redis     | Ready to accept connections
comprepdf-backend   | Server running on port 3000
comprepdf-worker    | celery@hostname ready
comprepdf-frontend  | Compiled successfully
```

---

### Paso 3: Verificar que Todo Está Funcionando

Abre una **nueva terminal** (mantén la anterior corriendo) y ejecuta:

```bash
# Verificar que los contenedores están corriendo
docker-compose ps
```

Deberías ver 5 servicios con estado "Up".

```bash
# Probar el backend
curl http://localhost:3000/api/v1/health
```

Respuesta esperada:
```json
{"status":"ok","timestamp":"2025-11-21T..."}
```

---

### Paso 4: Probar desde el Navegador

#### A. Abrir la Aplicación

Abre tu navegador y ve a:
```
http://localhost:4200
```

#### B. Comprimir un PDF

1. **Necesitas un archivo PDF de prueba**. Si no tienes uno, puedes:
   - Crear un PDF desde Word/Google Docs
   - Descargar uno de internet
   - Usar cualquier PDF que tengas

2. **Arrastra el PDF** a la zona de drop en la aplicación, o haz clic en "Seleccionar archivo"

3. **Elige un nivel de compresión:**
   - 🟢 **Baja (72 DPI)** - Máxima compresión, buena para pantallas
   - 🟡 **Media (150 DPI)** - Balance entre calidad y tamaño
   - 🔴 **Alta (300 DPI)** - Mejor calidad, menos compresión

4. **Haz clic en "Comprimir PDF"**

5. **Espera** mientras se procesa (verás una barra de progreso)

6. **Descarga** el archivo comprimido cuando esté listo

7. **Compara los tamaños** - Verás el tamaño original vs comprimido y el porcentaje ahorrado

#### C. Ver Estadísticas

1. Haz clic en **"Estadísticas"** en la barra superior

2. Verás:
   - 📊 Total de trabajos procesados
   - ✅ Tasa de éxito
   - 📉 Ratio de compresión promedio
   - 💾 Espacio total ahorrado
   - 📅 Estadísticas diarias
   - 📋 Trabajos recientes

---

### Paso 5: Probar la API con curl

#### A. Comprimir un PDF

```bash
# Reemplaza "test.pdf" con la ruta a tu archivo PDF
curl -X POST http://localhost:3000/api/v1/compress \
  -F "file=@test.pdf" \
  -F "compressionLevel=medium"
```

Recibirás una respuesta con el `jobId`:
```json
{
  "success": true,
  "data": {
    "jobId": "abc-123-def-456",
    "status": "pending",
    ...
  }
}
```

#### B. Consultar el Estado

```bash
# Reemplaza abc-123-def-456 con tu jobId real
curl http://localhost:3000/api/v1/jobs/abc-123-def-456
```

Si está completado, verás:
```json
{
  "success": true,
  "data": {
    "status": "completed",
    "compressionRatio": 65.5,
    "downloadUrl": "/api/v1/jobs/abc-123-def-456/download"
  }
}
```

#### C. Descargar el Archivo Comprimido

```bash
curl -O -J http://localhost:3000/api/v1/jobs/abc-123-def-456/download
```

#### D. Ver Estadísticas Globales

```bash
curl http://localhost:3000/api/v1/stats
```

#### E. Ver Estadísticas Diarias (últimos 7 días)

```bash
curl http://localhost:3000/api/v1/stats/daily?days=7
```

#### F. Ver Trabajos Recientes

```bash
curl http://localhost:3000/api/v1/stats/recent?limit=10
```

#### G. Ver Distribución por Nivel

```bash
curl http://localhost:3000/api/v1/stats/levels
```

---

### Paso 6: Ver los Logs

Si algo no funciona, revisa los logs:

```bash
# Ver todos los logs
docker-compose logs -f

# Ver logs del backend solamente
docker-compose logs -f backend

# Ver logs del worker
docker-compose logs -f python-worker

# Ver logs de MySQL
docker-compose logs -f mysql
```

---

### Paso 7: Verificar la Base de Datos

```bash
# Conectar a MySQL
docker-compose exec mysql mysql -u comprepdf -pcomprepdf123 comprepdf

# Dentro de MySQL, ejecuta:
SHOW TABLES;
SELECT * FROM compression_jobs;
SELECT * FROM compression_stats;

# Para salir:
exit;
```

---

### Paso 8: Verificar Redis

```bash
# Conectar a Redis
docker-compose exec redis redis-cli

# Ver todas las keys
KEYS *

# Ver trabajos pendientes en la cola
LLEN bull:compression-queue:wait

# Para salir:
exit
```

---

## 🧪 Escenarios de Prueba

### Prueba 1: PDF Normal
1. Sube un PDF de 5-10 MB
2. Usa nivel "Media"
3. Verifica que el archivo se reduce aproximadamente 50-70%

### Prueba 2: Diferentes Niveles
1. Sube el mismo PDF 3 veces
2. Prueba con nivel Baja, Media y Alta
3. Compara los resultados de compresión

### Prueba 3: PDF Muy Grande
1. Sube un PDF de 20-30 MB (con muchas imágenes)
2. Observa el tiempo de procesamiento
3. Verifica la reducción de tamaño

### Prueba 4: Múltiples PDFs
1. Sube varios PDFs seguidos
2. Observa que todos se procesan en orden
3. Verifica las estadísticas actualizadas

### Prueba 5: Validación de Errores
1. Intenta subir un archivo .txt o .jpg
2. Verifica que recibes un error de validación
3. Intenta sin seleccionar archivo
4. Verifica el mensaje de error

---

## 🛑 Detener el Sistema

Cuando termines de probar:

```bash
# Opción 1: Detener (puedes reiniciar después)
docker-compose stop

# Opción 2: Detener y eliminar contenedores
docker-compose down

# Opción 3: Limpieza completa (borra todo, incluyendo la DB)
docker-compose down -v
```

---

## ❓ Troubleshooting

### Problema: "Port is already allocated"

**Solución:** Otro servicio está usando ese puerto.

```bash
# Windows - Ver qué usa el puerto 3000
netstat -ano | findstr :3000

# Detener el proceso o cambiar el puerto en docker-compose.yml
```

### Problema: MySQL no está listo

**Solución:** Espera 30-60 segundos más.

```bash
# Ver cuando MySQL está listo
docker-compose logs mysql | grep "ready for connections"
```

### Problema: Worker no procesa trabajos

**Solución 1:** Verifica logs del worker
```bash
docker-compose logs python-worker
```

**Solución 2:** Reinicia el worker
```bash
docker-compose restart python-worker
```

### Problema: Frontend muestra error de conexión

**Solución:** Verifica que el backend está corriendo
```bash
curl http://localhost:3000/api/v1/health
```

### Problema: Docker no inicia

**Solución:**
1. Cierra Docker Desktop completamente
2. Reinicia tu computadora
3. Abre Docker Desktop de nuevo
4. Espera a que esté completamente iniciado

---

## 📊 Checklist de Prueba Completa

- [ ] Docker Desktop está corriendo
- [ ] Todos los servicios levantaron correctamente (5/5)
- [ ] Backend health check responde OK
- [ ] Frontend carga en http://localhost:4200
- [ ] Puedo subir y comprimir un PDF desde la interfaz
- [ ] El archivo se descarga correctamente
- [ ] Puedo ver las estadísticas en /stats
- [ ] Puedo comprimir PDFs con diferentes niveles
- [ ] Las estadísticas se actualizan correctamente
- [ ] Los trabajos aparecen en "Trabajos Recientes"
- [ ] Todos los endpoints de API funcionan con curl
- [ ] La validación de archivos no-PDF funciona
- [ ] Los logs no muestran errores críticos

---

## 🎯 Próximos Pasos

Si todo funciona correctamente:

1. ✅ **Has probado exitosamente ComprePDF**
2. 📖 Consulta `TESTING.md` para pruebas más avanzadas
3. 📝 Consulta `README.md` para documentación completa
4. 🔧 Modifica y personaliza según tus necesidades

---

## 📞 URLs Importantes

- **Frontend:** http://localhost:4200
- **API Health:** http://localhost:3000/api/v1/health
- **API Estadísticas:** http://localhost:3000/api/v1/stats
- **Dashboard Estadísticas:** http://localhost:4200/stats

---

## 💡 Tips

1. **Usa PDFs con imágenes** - Se comprimen mejor que PDFs de solo texto
2. **El nivel "Baja"** es perfecto para documentos que solo leerás en pantalla
3. **El nivel "Alta"** es mejor si necesitas imprimir el documento
4. **Los archivos expiran en 24 horas** - Descarga tus archivos comprimidos pronto
5. **Puedes ejecutar múltiples workers** editando `docker-compose.yml` y agregando réplicas

---

¡Listo para probar! 🚀

**Paso siguiente:** Abre Docker Desktop y ejecuta `docker-compose up --build`
