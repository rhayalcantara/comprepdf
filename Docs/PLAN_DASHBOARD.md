# PLAN — Rediseño del dashboard (operaciones + usuarios, no solo compresión)

> **Estado:** BORRADOR para discusión — no iniciado.
> **Fecha:** 2026-07-14 · **Rama prevista:** `feat/dashboard` (desde `feat/usuarios`)

---

## 1. Objetivo

El dashboard (`/stats`) fue concebido cuando ComprePDF **solo comprimía**. Hoy hay
**8+ operaciones** (compress, split, merge, sign, extract, rotate, protect, unlock,
+ emisión de certificados) y **usuarios autenticados con ownership**. El panel debe
dejar de asumir "todo es compresión" y volverse **consciente de la operación** y
**consciente del rol** (lo que ve un usuario vs. lo que ve un admin).

---

## 2. Diagnóstico del estado actual (qué está mal hoy)

Basado en `backend/src/controllers/stats.controller.ts` y
`frontend/src/app/features/stats/`:

1. **Todo se enmarca en compresión.** El resumen global expone `avgCompressionRatio`,
   `totalSpaceSaved`, `totalCompressions`, y la tabla de recientes muestra
   `compressionLevel`/`ratio` (`stats.controller.ts:48-63`, `:142-155`). Para
   split/merge/sign/extract/rotate/protect/unlock/certificate esas cifras no
   significan nada (salen `null`).
2. **Mezcla de universos.** `totalJobs` cuenta TODOS los jobs, pero las medias
   (`avgCompressionRatio`, `avgProcessingTime`, `totalSpaceSaved`) salen de la tabla
   `CompressionStats`, que **solo se llena para compress**. El "success rate" es de
   todos los jobs pero el resto de tarjetas es solo de compresión → lectura engañosa.
3. **La tendencia diaria ignora el 90% de las herramientas.** `getDailyStats`
   agrupa filas de `CompressionStats` (`:80-97`) → el gráfico de 7 días no ve
   ninguna operación que no sea compresión.
4. **No hay desglose por operación.** `operation_type` existe en `compression_jobs`
   pero no se surface en ningún lado; solo hay "distribución por nivel de compresión"
   (`getCompressionLevelStats`, `:163-190`).
5. **No hay dimensión de usuarios.** Con ownership y roles, el admin no ve: cuántos
   usuarios hay, cuántos activos/pendientes, quién usa la herramienta, actividad por
   usuario, ni las **activaciones pendientes** (que hoy solo se ven entrando a
   /usuarios). El `getLevelLabel` del front ya intuye el problema con un fallback
   `'Otras operaciones'` (`stats.component.ts:104`).
6. **Sin salud operativa.** No hay visibilidad de jobs `failed` (para actuar), en
   proceso, uso de almacenamiento de `outputs`, ni jobs próximos a expirar (24h).
7. **Sin librería de gráficos.** Todo son tablas y tiles (`stats.component.html`).
   Aceptable, pero limita la lectura de tendencias/proporciones.

Lo que SÍ está bien y se reutiliza:
- El filtro de ownership `statsUserId(req)` (`stats.controller.ts:12-17`): admin =
  global, usuario = lo suyo. Es la base del panel consciente de rol.
- La tabla `CompressionStats` sigue siendo válida para las métricas propias de
  compresión (ratio, tiempo, espacio ahorrado) — no se elimina, se **acota**.

---

## 3. Propuesta: dashboard consciente de operación y de rol

Misma ruta `/stats` (renombrada conceptualmente a **"Panel"**), con contenido según
el rol:

### 3.1 Vista de usuario — "Mi actividad"
- **Tarjetas de resumen (KPIs):** mis trabajos totales, completados, fallidos, en
  proceso; % de éxito. (Agnóstico de operación.)
- **Uso por herramienta:** desglose de MIS jobs por `operation_type` (barras/donut):
  cuántas compresiones, uniones, firmas, etc.
- **Tarjeta "Compresión"** (solo si el usuario comprimió): ratio medio, espacio
  ahorrado, tiempo medio — las métricas que hoy dominan el panel, ahora acotadas y
  claramente etiquetadas como propias de compresión.
- **Tendencia (7/30 días):** MIS trabajos por día, apilados por operación.
- **Actividad reciente:** últimos N jobs con **operación**, archivo, estado, fecha,
  y acción (ir a Mis trabajos / descargar). Sin columnas de compresión fijas.

### 3.2 Vista de admin — "Panel de administración" (todo lo anterior en global +)
- **Usuarios:** total, activos, inactivos, y **pendientes de activación** como
  tarjeta accionable (link directo a /usuarios) — cierra el hueco de que hoy solo se
  ven entrando al CRUD.
- **Actividad por usuario:** top usuarios por nº de trabajos (tabla), para saber
  quién usa la herramienta.
- **Salud operativa:** jobs `failed` (con acceso rápido), en proceso/pendientes,
  uso de almacenamiento (suma de tamaños en `files` de tipo output), y jobs próximos
  a expirar.
- **Recientes globales:** incluye columna **usuario** (ya soportada en el patrón de
  `GET /jobs?all=true`).

---

## 4. Cambios por componente

### 4.1 Backend (`backend/src/controllers/stats.controller.ts`)

Generalizar los endpoints para que sean **operation-aware**. Mantener el envelope
`{ success, data }` y el filtro `statsUserId` (rol-aware) existente.

- **`GET /stats/overview`** (reemplaza/expande `getGlobalStats`):
  - Agnóstico: `totalJobs`, `completed/failed/pending/processing`, `successRate`.
  - `byOperation`: `[{ operation, count, completed, failed }]` agrupando por
    `operation_type` (nuevo; la fuente es `compression_jobs`, no `CompressionStats`).
  - `compression`: bloque anidado SOLO de compresión (avgRatio, avgTime,
    totalOriginal/Compressed, spaceSaved) desde `CompressionStats` — lo actual, pero
    claramente separado.
  - `storage`: bytes totales de outputs vigentes (suma en `files`).
  - Si `req.user.rol==='admin'`: añade `users` `{ total, activos, inactivos,
    pendientes }` y `topUsers` `[{ username, jobs }]`.
- **`GET /stats/daily`**: contar **todos** los jobs por día (agrupar
  `compression_jobs.created_at`), opcionalmente desglosado por `operation_type` para
  el apilado. Parámetro `days` (7/30). (Deja de depender solo de `CompressionStats`.)
- **`GET /stats/operations`** (nuevo; sustituye conceptualmente a
  `getCompressionLevelStats`): conteo por `operation_type`; el desglose por nivel
  DPI queda anidado dentro de `compress`.
- **`getRecentJobs`**: añadir `operationType` y, en modo admin, `username` (batch
  lookup como en `jobs.controller`); las columnas de compresión pasan a ser opcionales.
- Todos siguen filtrando por dueño salvo admin (reutilizar `statsUserId`).
- **Tests** (jest): overview agnóstico + bloque compresión; byOperation; daily de
  todas las operaciones; ownership (usuario ve lo suyo, admin global); bloque `users`
  solo para admin.

### 4.2 Frontend (`frontend/src/app/features/stats/`)

- Reescribir `stats.component` como panel **rol-aware** (usa `AuthService.isAdmin`).
- Componentizar en tarjetas: `kpi-card`, `operation-breakdown` (barras/donut),
  `compression-card`, `trend-chart`, `recent-activity`, y (admin) `users-summary`
  (con pendientes accionables), `top-users`, `health-panel`.
- `api.service`: tipar las nuevas respuestas (`overview`, `operations`, daily
  ampliado, recent con operación/usuario).
- Reutilizar el catálogo de herramientas (`core/tool-catalog.ts`) para íconos,
  colores y etiquetas de cada operación → coherencia visual con el resto de la app.
- Etiquetas de operación en español (Comprimir, Dividir, Unir, Firmar, …).

### 4.3 Gráficos — decisión pendiente (ver §6)
Propuesta: **CSS/SVG a mano** (barras + donut simples) para v1, sin dependencia
nueva; el dataset es pequeño. Alternativa: añadir una librería ligera
(`ng2-charts`/Chart.js o `ngx-charts`) si se quieren tooltips/animaciones ricos.

### 4.4 Base de datos
- **Ninguno.** Toda la información ya existe: `operation_type`, `user_id`, `status`,
  `created_at`, `completed_at` en `compression_jobs`; tamaños en `files`; métricas de
  compresión en `compression_stats`. Es un cambio de agregación/lectura.

---

## 5. Fases y estimación

| # | Fase | Contenido | Est. |
|---|---|---|---|
| 1 | Backend | overview/daily/operations/recent operation-aware + bloque users/health para admin + tests | 1–1.5 d |
| 2 | Frontend | panel rol-aware, tarjetas, desglose por operación, tarjeta compresión acotada, recientes con operación/usuario, gráficos CSS/SVG | 1.5–2 d |
| 3 | Admin | panel de usuarios (pendientes accionables, top usuarios) + salud operativa | 0.5 d |
| 4 | Deploy + verificación | E2E (usuario vs admin) local → deploy a QA (sin migración) | 0.5 d |
| | **Total** | | **~3–4 días** |

Sin migración ni cambios en el worker → desplegable de forma incremental como el
resto de la rama de usuarios.

---

## 6. Preguntas abiertas (decidir antes de implementar)

1. **Gráficos:** ¿CSS/SVG a mano (sin dependencia, recomendado para v1) o añadimos
   una librería (Chart.js/ngx-charts) para tendencias más ricas?
2. **¿El panel es la landing tras login?** Hoy la landing es `/` (home de
   herramientas). ¿El dashboard debería ser lo primero que ve el usuario al entrar,
   o seguir como sección aparte?
3. **Rango temporal:** ¿7/30 días fijos, o selector con rango personalizado?
4. **Drilldown de usuario (admin):** ¿en v1 basta el "top usuarios", o se quiere
   click → ver los trabajos de ese usuario?
5. **Almacenamiento:** ¿mostramos uso de disco de outputs (suma de `files`) y jobs
   próximos a expirar, o lo dejamos para v2?
6. **Nombre:** ¿renombramos "Estadísticas" a "Panel"/"Dashboard" en el menú?
