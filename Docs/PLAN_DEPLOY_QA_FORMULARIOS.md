# Plan de despliegue a QA — Módulo de Formularios PDF

> **Estado:** ✅ EJECUTADO (2026-07-15) · **Fecha:** 2026-07-15 · **Rama:** feat/dashboard

## Resultado de la ejecución (2026-07-15)

Desplegado y verificado en QA (`192.168.7.222`):
- **QA estaba apagado** (reinicio del box); se levantó con un coldstart sin `pause` vía schtasks.
- **Backup previo** 🔒: `backups\comprepdf_pre_forms_20260715_2115.sql` (46 jobs, 6 usuarios) +
  copias-aside `backend\dist_prev`, `worker\comprepdf-worker_prev`, `frontend\browser_pre_forms`.
- **Migración 005** aplicada: enum con `form_generate` + tabla `pdf_forms`; **46 jobs intactos**.
- **Backend** (sin deps npm nuevas): `dist` swapeado, `/api/v1/forms` responde 401 (ruta viva).
- **Worker** reconstruido con **reportlab** (`collect_all` en `comprepdf-worker.spec`): swapeado y
  **verificado en QA** inyectando un job `form_generate` en MySQL → PDF AcroForm generado (`completed`).
- **Frontend** build `qa` (nuevo `environment.qa.ts` + `fileReplacements`) copiado y `:8090` reiniciado.
- **Data valiosa intacta**: 40 jobs `completed` + 6 usuarios. Durante la ventana desaparecieron 6 jobs
  `failed` (housekeeping de un admin mientras QA estuvo accesible; presentes en el backup — se dejaron
  borrados por decisión del usuario).
- **Pendiente menor**: no se pudo hacer el E2E autenticado por la UI (TI cambió la contraseña de admin
  de QA; no disponible desde la sesión) y borrar ~20 bats/logs temporales del share (cosmético; QA
  cayó por su corte de red intermitente ICMP/HTTP conocido).

---


## Contexto

El módulo **Gestor de formularios PDF rellenables** (AcroForm) ya está implementado, probado
(168 tests backend / 67 worker) y mergeado en `feat/dashboard` (commit `c642664`, PR #1 → main).
Falta **promoverlo al entorno QA** (`192.168.7.222`, bundle nativo en `C:\comprepdf`), que ya
contiene **datos reales que deben preservarse** (usuarios, jobs, certificados emitidos, stats).

Riesgo principal, doble:
1. La **BD poblada** al aplicar la migración.
2. El **`.exe` del worker**, que ahora depende de `reportlab` (dependencia nueva) y debe
   reconstruirse con PyInstaller sin romper el arranque (histórico: "muere en bucle silencioso").

Estrategia: deploy **incremental por pieza**, con **backup completo previo** y **rollback granular**.

### Deltas de esta feature vs QA actual
| Pieza | Cambio | Nota |
|---|---|---|
| **DB** | Aplicar `database/migrations/005_pdf_forms.sql` | QA está en 004. Aditivo/no destructivo. |
| **Backend** | Nuevos `.ts` → `dist` (`/api/v1/forms` + `form_generate`) | **Sin deps npm nuevas** → no tocar `node_modules`. |
| **Worker** | `app/operations/form_generate.py` + **`reportlab`** | **Rebuild del `.exe`** (dep nueva). |
| **Frontend** | Nuevo `features/forms/` | Rebuild `browser` con API de QA. |
| **Envs** | Ninguna nueva | QA no necesita Ghostscript para formularios. |

### Decisiones
- Actualización **incremental por pieza** (no re-bundle ZIP completo).
- Arreglar el env del frontend: añadir `environment.qa.ts` + `fileReplacements` (elimina editar
  `environment.ts` a mano).

## Referencias
- Mecánica QA: `Docs/SEGUIMIENTO_SESION.md`. MySQL de QA es **solo-localhost** → SQL y `mysqldump`
  se ejecutan **en la propia máquina** vía bat + `schtasks /s 192.168.7.222 /ru SYSTEM`, con salida
  a un log en el share `\\192.168.7.222\c$\comprepdf`.
- Build worker: `python-worker/comprepdf-worker.spec` + receta en `python-worker/worker_entry.py`
  (crítico: DLLs de `mysql\vendor`).
- Migración: `database/migrations/005_pdf_forms.sql` (manual; ya reflejada en `database/schema.sql`).
- Restart QA (scripts que viven **solo en QA**): `update-backend-worker.bat`, `restart-frontend.bat`.

---

## Tareas

### Fase 1 — Preparación de builds (local, antes de tocar QA)

- [ ] **1a. Frontend env** — Crear `frontend/src/environments/environment.qa.ts`
      (`{ production: true, apiUrl: 'http://192.168.7.222:3000/api/v1' }`); añadir configuración
      `qa` en `frontend/angular.json` (extiende `production` + `fileReplacements`
      `environment.ts` → `environment.qa.ts`). Verificar `ng build --configuration=qa`. `environment.ts`
      queda intacto en `localhost`.
- [ ] **1b. Worker `.exe` con reportlab** — Editar `python-worker/comprepdf-worker.spec`:
      `collect_all('reportlab')` (fuentes + submódulos + `_rl_accel`), fusionando
      `datas`/`binaries`/`hiddenimports`; mantener DLLs de `mysql\vendor` y `PIL`. Reconstruir
      (`python -m PyInstaller --noconfirm comprepdf-worker.spec`). **Verificación local
      imprescindible**: lanzar el `.exe` contra el MySQL local (ya tiene `pdf_forms` + enum
      `form_generate`), encolar un job `form_generate` y confirmar `completed` + PDF AcroForm.
- [ ] **1c. Backend `dist`** — `cd backend && npm run build`; confirmar `dist/` incluye
      `controllers/form.controller.js`, `models/pdf-form.model.js`, `utils/form-definition.js`.
      **No** copiar `node_modules`.

### Fase 2 — BACKUP en QA (antes de cualquier cambio) 🔒
Server-side en QA, vía bat + `schtasks` como SYSTEM, salida a log en el share:
- [ ] **`backup-db.bat`**: `mysqldump -u root -p<...> --databases comprepdf --single-transaction
      --routines --triggers > C:\comprepdf\backups\comprepdf_pre_forms_<YYYYMMDD_HHMM>.sql`; volcar
      tamaño/últimas líneas a `backup-db.log`. Verificar que termina en `-- Dump completed` y pesa > 0.
- [ ] **Backups de código** (copias-aside, sin swap aún): `backend\dist` → `backend\dist_prev`;
      `worker\comprepdf-worker` → `comprepdf-worker_prev`; `frontend\browser` → `frontend\browser_pre_forms`.
- [ ] Registrar todas las rutas de backup en el log (para el rollback).

### Fase 3 — Deploy incremental (en orden; verificar cada paso)
1. [ ] **DB migración 005** (tras backup). Copiar `005_pdf_forms.sql` al share; `run-migration.bat`
       lo aplica con el `mysql.exe` de QA → log. **Pre-check**: no re-aplicar si `pdf_forms` ya existe
       o el enum ya tiene `form_generate`. **Post-check**: `pdf_forms` existe y el enum lo incluye.
2. [ ] **Backend**: robocopy `dist` → `\\...\c$\comprepdf\backend\dist`; reiniciar. Verificar
       `GET /health` y que `/api/v1/forms` responde 401 sin token.
3. [ ] **Worker**: copiar `dist/comprepdf-worker/` a la carpeta `_new` del worker en el share;
       `update-backend-worker.bat` hace swap + relanza backend+worker. (Ese bat consume `_new`; si
       luego hay que reiniciar solo el backend, hacerlo directo, no re-ejecutar el bat.)
4. [ ] **Frontend**: robocopy el `browser` (build `qa`) → `\\...\c$\comprepdf\frontend\browser`;
       `restart-frontend.bat` (:8090).

### Fase 4 — Verificación E2E en QA
Con **polls espaciados** (rate-limit del backend):
- [ ] Login admin → token.
- [ ] `POST /forms` → `POST /forms/:id/generate` → poll `GET /jobs/:id` hasta `completed` (confirma
      worker con reportlab) → `GET /jobs/:id/download` = `%PDF-` AcroForm.
- [ ] UI: `http://192.168.7.222:8090/formularios` — crear/editar/preview/descargar.
- [ ] **Data previa intacta**: listar usuarios y "Mis trabajos" (jobs/certificados previos presentes).

### Fase 5 — Cierre
- [ ] Actualizar `Docs/SEGUIMIENTO_SESION.md` y la memoria `qa-deploy-mechanics`: migración 005
      aplicada, worker rebuild con reportlab, rutas de backups, nuevo `environment.qa.ts`.
- [ ] Commit final en `feat/dashboard`.

---

## Rollback (por pieza, orden inverso al fallo)
- **Frontend**: restaurar `browser_pre_forms` → `browser`; `restart-frontend.bat`.
- **Worker/Backend**: restaurar `comprepdf-worker_prev` y `dist_prev`; relanzar.
- **DB**: 005 es aditiva (no borra datos) → normalmente **no** requiere revertir. Si fuese
  imprescindible: restaurar desde `comprepdf_pre_forms_<...>.sql` (drop+restore, con la app detenida).
  El `mysqldump` previo es la red de seguridad definitiva de la data.

## Riesgos y mitigaciones
- **Worker no arranca (reportlab mal empaquetado)** → verificación local 1b antes de QA; rollback a `comprepdf-worker_prev`.
- **Migración sobre DB poblada** → 005 aditiva/idempotente; `mysqldump` previo obligatorio; pre-check.
- **Rate-limit del backend** en verificación → espaciar polls (≥ varios segundos).
- **Bloqueo por `MODIFY COLUMN`** → aplicar en baja actividad (rápido, enum in-place).
- **Caída de red de QA no relacionada** (visto 2026-07-13) → robocopy diferencial reanuda.

## Criterio de éxito
(a) `/health` OK · (b) un formulario creado en la UI de QA genera y descarga un PDF AcroForm
rellenable · (c) usuarios/jobs/certificados previos intactos · (d) backups + rutas de rollback
registrados en el log del share.
