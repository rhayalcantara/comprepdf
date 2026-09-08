# Paso a producción — 2026-09-08

Registro de la sesión en la que ComprePDF pasó de QA Windows (192.168.7.222,
bundle nativo) a producción en Docker Compose (192.168.113.20), desplegado a
través del **Puente** (MCP de despliegue, proyecto `C:\Claude\Proyectos\PuenteDespliegue`).

## Resultado

| Entorno | Host | Estado al cierre |
|---|---|---|
| **Producción** | http://192.168.113.20:3060 (Ubuntu 24.04 x86_64, Compose) | main `32bd367`, 5 contenedores healthy, **datos migrados** (372 jobs, 23 usuarios, 1 formulario, 2 certificados, CA interna) |
| qa del Puente | http://192.168.2.165:3060 (DGX Spark, ARM64, Compose) | main `32bd367`, datos de QA Windows de esa mañana (371 jobs) |
| QA Windows (antiguo) | 192.168.7.222 | **parado**: backend y worker muertos, tarea "ComprePDF Autostart" deshabilitada. Revivir: habilitar la tarea y ejecutar `C:\comprepdf\qa-boot.bat` |

Los usuarios entran en producción con su usuario y contraseña de siempre (hashes
bcrypt migrados). El admin es el de TI de QA Windows.

## Protocolo del Puente (lo que hay que saber para el próximo deploy)

- Ningún agente recibe SSH. Se pide `desplegar(comprepdf, produccion)` al Puente;
  su secuencia es fija: `git checkout main` → `docker compose config -q` →
  `docker compose build` → `docker compose up -d` → salud. Sin `-f`, sin profiles.
- **Producción exige confirmación humana por operación**: `desplegar` devuelve
  `pendiente_confirmacion <id>` (caduca a los 15 min); Rhay confirma con
  `uv run python -m puente.cli confirmar <id> --por ralcantara`; la segunda
  llamada debe salir **del mismo proceso cliente** (misma sesión MCP).
- Antes hace falta una concesión de alcance (`solicitar_alcance` → Rhay concede
  con `puente.cli conceder <id> --dias N`); caducan.
- Producción no se abre para un proyecto que no haya desplegado antes a qa por el Puente.
- **El Puente no ejecuta SQL**: las migraciones las aplica el backend al arrancar
  (`backend/src/services/migration.service.ts`, tabla `schema_migrations`).
- Reglas que impone sobre el repo: ver la sección Docker de `CLAUDE.md`
  (`docker-compose.yml` = producción, `.env` única configuración, nada en
  `environment:` que repita el `.env`, un solo puerto publicado).

## Cambios de código de esta sesión (commits en main)

1. `9723e92` fix(compress): Ghostscript en Windows (`gswin64c`).
2. `4d7570d` feat(auth): login por usuario o correo; username editable.
3. `11034ea` feat(estudio): espacio de trabajo con operaciones encadenadas (migración 012).
4. `def78f4` feat(deploy): producción en Docker Compose vía el Puente —
   compose de producción + `docker-compose.dev.yml`, migraciones al arrancar,
   **LibreOffice** en la imagen del worker para `convert` (`converters/office_libre.py`,
   selector `converters/office.py`), `backend/Dockerfile` multi-stage con contexto
   raíz, `environment.prod.ts` con `apiUrl: '/api/v1'`, nginx con proxy `/api`.
5. `9cca8f5` fix(frontend): nginx sirve `.mjs` como JavaScript (el worker de pdf.js
   llegaba como `application/octet-stream` y el Estudio no cargaba el documento).

## Cronología

1. Portal MCP: sin accesos del 113.20 (ni documentos, tareas, minutas…). El
   host solo tiene SSH y RDP. La sesión "puente" explicó el protocolo.
2. Decisiones de Rhay: migraciones en el backend, LibreOffice en el worker,
   alta del MCP `puente` en la sesión (`claude mcp add puente -s local …`,
   `PUENTE_AGENTE=compre`). Las herramientas MCP no cargan en una sesión ya
   abierta: se usó un cliente stdio propio (`scratchpad/puente_client.py` y
   `puente_prod.py`) con la misma identidad.
3. Merge feat/dashboard → main (`4aa4df3`), push.
4. Deploy a qa (Spark): build ARM64 de las 5 imágenes en 206 s, healthy. Fix
   del MIME `.mjs` y segundo deploy (`32bd367`, solo frontend, 8 s).
5. Migración de datos a qa: dump de QA Windows (`qa-dump-migracion.bat` vía
   schtasks/SYSTEM), rutas de `files` reescritas a `/app/uploads|outputs`,
   archivos vigentes + `ca-store`; cargado por Rhay por SSH (`Docs/migracion-qa/CARGAR.md`).
6. Deploy a producción: la primera confirmación (#6) se perdió porque el harness
   mató el cliente por memoria baja a mitad del build (puente liberó el bloqueo);
   segunda (#7) con el cliente lanzado con `nohup … & disown`: build x86_64 227 s,
   healthy.
7. Corte: `qa-stop-corte.bat` paró QA Windows; dump final (372 jobs); cargado en
   el 113.20 por la sesión puente vía SSH con el OK de Rhay; `ADMIN_INITIAL_PASSWORD`
   vaciado y paquete borrado del servidor.

## Pendientes

- Rhay: prueba con credenciales en producción (login, descarga de un job de hoy,
  emisión de certificado como prueba de la passphrase de la CA) y anuncio de la
  URL a los usuarios.
- Actualizar el sistema id 7 en RSIA con la URL de producción (solo por la web;
  el MCP de RSIA no edita).
- `translate` depende del Ollama de la Spark del laboratorio (192.168.2.165:11434):
  si esa máquina se apaga, la traducción deja de funcionar en producción.
- Peculiaridad menor del 113.20: redis avisa de `vm.overcommit_memory`.
- QA Windows: decidir si se apaga definitivamente.
- `Docs/migracion-qa/` está en `.gitignore` (hashes + clave de la CA); borrar del
  portátil cuando ya no haga falta.
