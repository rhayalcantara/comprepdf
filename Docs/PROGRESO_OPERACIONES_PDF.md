# PROGRESO — Operaciones PDF (handoff antes de reiniciar)

> **Propósito de este documento:** conservar el estado del trabajo antes de
> instalar un MCP y reiniciar Claude Code. Al reiniciar se pierde el contexto de
> la conversación; este archivo permite retomar sin re-analizar todo.
>
> **Fecha del handoff:** 2026-07-06
> **Rama:** `feat/pdf-operations`

---

## TL;DR

La implementación de las **7 operaciones PDF + firma digital** está
**esencialmente completa** en las 3 capas (backend, worker, frontend) con tests.

⚠️ **Importante:** el código **NO sigue** `PLAN_OPERACIONES_PDF.md` tal como está
escrito. El plan describe una arquitectura **Celery + Redis Queue + PyMuPDF** que
fue abandonada. El código real usa la arquitectura de **polling a MySQL + pikepdf
+ pyHanko + Ghostscript** documentada en `CLAUDE.md`. **El código es la fuente de
verdad; el plan está desactualizado.**

---

## Estado por operación

| Operación | Backend (ruta+ctrl) | Worker handler | Frontend tab | Test | Estado |
|---|---|---|---|---|---|
| Split   | ✅ `splitPdf`     | ✅ `handle_split` (→ ZIP)      | ✅ | ✅ individual + rangos | **Listo** |
| Merge   | ✅ `mergePdfs`    | ✅ `handle_merge` (file_order) | ✅ | ✅ | **Listo** |
| Sign    | ✅ `signPdf`      | ✅ `handle_sign` (pyHanko PKCS#12) | ✅ | ✅ (cert faltante) | **Listo** |
| Extract | ✅ `extractPages` | ✅ `handle_extract`            | ✅ | ✅ | **Listo** |
| Rotate  | ✅ `rotatePages`  | ✅ `handle_rotate`            | ✅ | ✅ | **Listo** |
| Protect | ✅ `protectPdf`   | ✅ `handle_protect` (AES-256) | ✅ | ✅ | **Listo** |
| Unlock  | ✅ `unlockPdf`    | ✅ `handle_unlock`           | ✅ | ✅ (pw correcta + incorrecta) | **Listo** |

Piezas de soporte presentes:
- Migración `database/migrations/001_pdf_operations.sql` + `database/schema.sql` actualizado
- `OperationType` en `backend/src/models/job.model.ts`
- Middleware `uploadMultiple` / `uploadSign` + `validatePdfFiles`
- Endpoints genéricos `/jobs/:jobId` (status + download + delete) que manejan `compressed` y `output`
- Métodos del `ApiService` (frontend) para las 7 operaciones + sign
- Ruta `/tools` + enlace en la barra de navegación (`app.component.ts`)
- `poller.py` con el mapa `HANDLERS` cableando los 8 handlers
- `pikepdf==8.7.1` y `pyHanko==0.25.1` en `requirements.txt`

---

## Arquitectura real (la que hay que respetar)

```
Angular (4200) → Node.js API (3000) → MySQL ← (poll) Python Worker
                                         ↑                  │
                                         └── escribe output ┘
```

- El backend inserta una fila en `compression_jobs` con `status='pending'`,
  `operation_type` y `operation_params` (JSON), más el/los archivo(s) en `files`.
- `python-worker/app/workers/poller.py` reclama el job con
  `SELECT ... FOR UPDATE SKIP LOCKED` y despacha al handler en `app/operations/`.
- El handler escribe el archivo de salida (`file_type='output'`) y devuelve; el
  poller marca `completed`/`failed`.
- **NO hay broker de mensajes** (BullMQ y Celery fueron eliminados).

Handlers: `app/operations/compress.py` (Ghostscript), `pdf_ops.py`
(split/merge/extract/rotate/protect/unlock, pikepdf), `sign.py` (pyHanko).
Utilidades compartidas en `app/operations/common.py`.

---

## Desviaciones respecto al plan (todas son mejoras)

1. **Sign = firma criptográfica real** (pyHanko + certificado `.pfx` PKCS#12), no
   la "marca de agua / firma visual" del plan. Las credenciales se destruyen tras
   firmar (`_destroy_credentials` borra el `.pfx` y elimina la contraseña de
   `operation_params`).
2. **Split devuelve un único ZIP**, no N filas de archivo en la DB.
3. **Sin PyMuPDF** — pikepdf hace split/merge/extract/rotate/protect/unlock;
   Ghostscript se queda para compress.

---

## Pendientes / observaciones (no bloqueantes)

- [ ] **Docs desactualizados.** Reescribir `PLAN_OPERACIONES_PDF.md`
      (Celery/Redis/PyMuPDF → polling/pikepdf/pyHanko). También `CLAUDE.md` aún
      muestra el comando `celery -A app.workers.compression_worker worker` y
      "Celery tasks" en la estructura — ese worker fue eliminado.
- [ ] **`files_output` fantasma.** El plan (Fase 1) y los handlers retornan
      `{'files_output': N}`, pero la migración real nunca agrega esa columna. El
      poller ignora el valor de retorno → dato muerto e inofensivo (solo lo leen
      los tests).
- [ ] **`redis==5.0.1`** sigue en `requirements.txt` aunque el worker ya no usa
      Redis para entrega de jobs (Redis es solo caché ahora). Verificar si el
      worker aún lo necesita; si no, quitarlo.
- [ ] **Inconsistencia menor de validación.** `/pdf/unlock` es la única ruta PDF
      sin `validatePdfFile`, y su controlador no llama `assertIsPdf` → acepta
      cualquier archivo (falla luego en el worker). Riesgo bajo.
- [ ] **Limpieza de `.pfx` huérfanos.** Si el worker nunca procesa un job de
      firma (worker caído + job expira), el `.pfx` y su contraseña quedan (en
      disco / en DB) hasta la limpieza, porque `_destroy_credentials` solo corre
      dentro del handler. Considerar un barrido por TTL si importa.

---

## ✅ Verificación E2E ejecutada (2026-07-06)

Se levantó la pila **nativa (sin Docker)** y se probaron las **8 operaciones de
punta a punta** con éxito. Entorno montado:

- **MySQL 8.0.40 portable** en `C:\Proyectos\mysql-test\` (ZIP, sin admin),
  `schema.sql` aplicado + usuario `comprepdf`/`comprepdf123` (`mysql_native_password`).
- Backend Node `:3000` (reconectó solo vía pool mysql2), worker `poller.py`,
  frontend Angular `:4200`.
- Deps del worker (pikepdf, pyHanko, mysql-connector) ya estaban instaladas global.

### Resultados

| Operación | Cómo se probó | Resultado |
|---|---|---|
| Split   | Playwright (UI) | `test10.pdf` → ZIP con **10 PDFs** individuales, descargado ✓ |
| Merge   | Playwright (UI) | 2 PDFs (3+4 pág) → `merged.pdf` con **7 páginas**, orden correcto ✓ |
| Extract | API | `2-4,8` → **4 páginas** ✓ |
| Rotate  | API | 90° todas → `/Rotate=90` en todas ✓ |
| Protect | API | exige password; abre con clave (10 pág) ✓ |
| Unlock  | API | abre sin clave ✓; clave incorrecta → job `failed: Incorrect password` ✓ |
| Sign    | API | pyHanko + `.pfx` self-signed → **1 firma embebida** `Signature1` que cubre todo el doc ✓; **credenciales destruidas** (cert_password/cert_path fuera de la DB, `.pfx` borrado del disco) ✓ |

### Observaciones de la prueba

- **Ghostscript no está en PATH** → la operación **`compress`** (la original)
  fallaría hasta instalarlo. No afecta las 7 operaciones nuevas + firma.
- Quirk de Playwright: el file chooser a veces abre diálogos duplicados; se
  resuelve subiendo el archivo en un solo ciclo sin snapshots intermedios.
- La UI renderiza los 7 tabs; único error de consola: `404 favicon.ico` (cosmético).

### Levantar / detener la pila nativa

```powershell
.\scripts\dev-stack.ps1 start    # arranca MySQL + backend + worker + frontend
.\scripts\dev-stack.ps1 status   # estado de cada servicio
.\scripts\dev-stack.ps1 stop     # detiene todo
```

### Comandos de referencia (Docker, cuando esté disponible)

```bash
# Migración sobre una DB existente (no en DB fresca; schema.sql ya trae las columnas)
mysql -u root -p comprepdf < database/migrations/001_pdf_operations.sql
# Tests unitarios del worker
cd python-worker && pytest tests/test_pdf_operations.py -v
# Stack completo
docker-compose up -d
```

---

## Archivos clave (para reorientarse rápido)

**Backend**
- `backend/src/controllers/pdf-operation.controller.ts` — controladores de las 7 ops + sign
- `backend/src/controllers/compress.controller.ts` — status/download/delete genéricos
- `backend/src/routes/index.ts` — rutas
- `backend/src/middlewares/{upload,validation}.middleware.ts`
- `backend/src/models/job.model.ts` — `OperationType`

**Worker**
- `python-worker/app/workers/poller.py` — loop + `HANDLERS`
- `python-worker/app/operations/{common,compress,pdf_ops,sign}.py`
- `python-worker/tests/test_pdf_operations.py`

**Frontend**
- `frontend/src/app/features/tools/tools.component.{ts,html,scss}`
- `frontend/src/app/core/services/api.service.ts`
- `frontend/src/app/app.routes.ts` (ruta `/tools`), `app.component.ts` (nav)

**Infra / DB**
- `database/schema.sql`, `database/migrations/001_pdf_operations.sql`
- `python-worker/{Dockerfile,requirements.txt}`, `docker-compose.yml`
</content>
</invoke>
