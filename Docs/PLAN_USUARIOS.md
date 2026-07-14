# PLAN — Usuarios y trazabilidad de acciones (auth + ownership de jobs)

> **Estado:** BORRADOR para discusión — no iniciado.
> **Fecha:** 2026-07-14 · **Rama prevista:** `feat/usuarios` (desde `feat/pdf-operations`)

---

## 1. Objetivo

Que ComprePDF tenga **usuarios autenticados** y que **toda acción quede ligada al
usuario que la ejecutó**: cada job (comprimir, split, merge, firmar, extraer,
rotar, proteger, desbloquear, emitir certificado) debe registrar quién lo creó,
y cada usuario solo debe poder ver/descargar/borrar **sus propios trabajos**.

### Alcance (v1)
- Login con **usuario/contraseña local** (tabla `users`, hash bcrypt) + **JWT**.
- Columna `user_id` en `compression_jobs` → historial "Mis trabajos" por usuario.
- Autorización por ownership: `GET/DELETE /jobs/:id` y descarga solo del dueño
  (o de un admin).
- Roles: `admin` y `user`. El admin gestiona usuarios, ve todos los jobs y las
  estadísticas globales; el módulo de certificados pasa a exigir rol `admin`.
- Frontend: pantalla de login, guard de rutas, interceptor que adjunta el token,
  vista "Mis trabajos", y gestión de usuarios (solo admin).

### Fuera de alcance (v1)
- Login con Active Directory / LDAP (v2 — la tabla `users` deja el campo
  `auth_provider` preparado para eso).
- Autorregistro público (los usuarios los crea TI/admin; es una herramienta interna).
- Refresh tokens con rotación / revocación en Redis (v2; en v1 el JWT expira y
  se vuelve a hacer login).
- Cuotas o límites por usuario.

---

## 2. Decisiones de diseño (propuestas — discutir)

| Tema | Propuesta | Alternativa |
|---|---|---|
| Autenticación | **JWT firmado (HS256, secret en env `JWT_SECRET`)**, expiración 8h (jornada laboral), enviado en `Authorization: Bearer` | Sesiones server-side en Redis |
| Origen de usuarios | **Tabla local `users`**, alta por admin desde el frontend | AD/LDAP (v2) |
| Hash de contraseña | **bcrypt** (`bcryptjs`, cost 12) | argon2 |
| ¿Uso anónimo? | **NO** — todas las operaciones exigen login (herramienta interna de la coop) | Permitir anónimo y ligar solo si hay token |
| `user_id` en jobs | Columna **NULL** con FK `ON DELETE SET NULL` (los jobs viejos quedan huérfanos pero visibles para admin; borrar un usuario no borra su historial) | NOT NULL + backfill a un usuario "legacy" |
| Módulo certificados | El `X-Admin-Key` se **reemplaza** por `requireRole('admin')` (una sola forma de autenticarse) | Mantener ambos en paralelo durante la transición |
| Primer admin | **Seed en la migración** (`admin` / contraseña temporal en env `ADMIN_INITIAL_PASSWORD`, forzar cambio al primer login) | Script CLI aparte |
| Worker Python | **Sin cambios** — el ownership se resuelve 100% en el backend; el poller no necesita saber de usuarios | Propagar user al worker para logs |

**Regla clave de migración:** `user_id` nace nullable para que los jobs
existentes y el flujo actual no se rompan; el enforcement (rechazar requests sin
token) se activa al final (Fase 3), cuando el frontend ya sabe loguearse. Así la
rama es desplegable en cualquier punto intermedio.

---

## 3. Arquitectura

```
Angular (login → guarda JWT) ──Authorization: Bearer──► Node API
                                                          │ auth.middleware verifica JWT
                                                          │ req.user = { id, rol }
                                                          ▼
                                              INSERT compression_jobs (…, user_id)
                                                          │
                                                          ▼ (poll, sin cambios)
                                                    Python Worker
```

### Migración `database/migrations/003_users.sql`

```sql
CREATE TABLE users (
    id            VARCHAR(36) PRIMARY KEY,
    username      VARCHAR(100) UNIQUE NOT NULL,
    email         VARCHAR(255) UNIQUE NULL,
    nombre        VARCHAR(255) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    rol           ENUM('admin','user') NOT NULL DEFAULT 'user',
    estado        ENUM('activo','inactivo') NOT NULL DEFAULT 'activo',
    auth_provider ENUM('local','ad') NOT NULL DEFAULT 'local',  -- preparado para v2
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMP NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE compression_jobs
    ADD COLUMN user_id VARCHAR(36) NULL AFTER id,
    ADD CONSTRAINT fk_jobs_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE SET NULL,
    ADD INDEX idx_user_created (user_id, created_at);

-- Auditoría en certificados: quién emitió (hoy 'emitido_por' es texto libre)
ALTER TABLE certificados_emitidos
    ADD COLUMN emitido_por_user_id VARCHAR(36) NULL,
    ADD CONSTRAINT fk_cert_user FOREIGN KEY (emitido_por_user_id)
        REFERENCES users(id) ON DELETE SET NULL;
```

(+ actualizar `database/schema.sql` para instalaciones desde cero, y seed del
primer admin.)

### Endpoints nuevos / cambiados

```
POST   /api/v1/auth/login            # { username, password } → { token, user }
GET    /api/v1/auth/me               # Perfil del token actual
POST   /api/v1/auth/change-password  # Cambio de contraseña propio

GET    /api/v1/users                 # (admin) Listar usuarios
POST   /api/v1/users                 # (admin) Crear usuario
PATCH  /api/v1/users/:id             # (admin) Editar rol/estado/reset password
                                     #   (no DELETE físico: estado='inactivo')

GET    /api/v1/jobs                  # NUEVO: mis trabajos (admin: ?all=true)

# Cambiadas (ahora requieren token):
POST   /api/v1/compress, /pdf/*      # guardan user_id = req.user.id
GET    /api/v1/jobs/:id[, /download] # solo dueño o admin (404 si es de otro)
DELETE /api/v1/jobs/:id              # solo dueño o admin
GET    /api/v1/stats*                # user: sus números · admin: globales
POST/GET /api/v1/certificates        # requireRole('admin') en vez de X-Admin-Key
GET    /api/v1/health                # ÚNICA ruta pública
```

---

## 4. Fases y tareas

### Fase 1 — Backend: auth base (1–1.5 días)
- [ ] Migración `003_users.sql` (tabla `users`, `user_id` en jobs, auditoría en
      certificados, seed admin) + reflejar en `database/schema.sql`.
- [ ] Dependencias: `bcryptjs`, `jsonwebtoken` (+ types).
- [ ] `config/env.ts`: `JWT_SECRET` (fail-closed como `CERT_ADMIN_KEY`: sin
      secret, el login queda bloqueado), `JWT_EXPIRES_IN`, `ADMIN_INITIAL_PASSWORD`.
      Actualizar `.env.example` (raíz y backend).
- [ ] `models/user.model.ts`: findByUsername, create, update, list, updateLastLogin.
- [ ] `controllers/auth.controller.ts`: login (bcrypt compare, rechazar
      `estado='inactivo'`, firmar JWT con `{ sub, rol }`), me, changePassword.
- [ ] `middlewares/auth.middleware.ts`: `requireAuth` (verifica Bearer, carga
      `req.user`) y `requireRole('admin')`. Tipar `req.user` (extensión de
      `Express.Request`).
- [ ] Rate-limit específico en `/auth/login` (ya existe rate-limit global —
      endurecerlo aquí contra fuerza bruta).
- [ ] Tests: login ok/fail/inactivo, token expirado, requireRole.

### Fase 2 — Backend: ownership de jobs (1 día)
- [ ] `compress.controller.ts` y `pdf-operation.controller.ts`: guardar
      `user_id: req.user.id` al insertar el job.
- [ ] `job.model.ts`: incluir `user_id` en insert/select; nuevo
      `listByUser(userId, {page, limit})`.
- [ ] `GET /jobs` (nuevo controller): historial paginado del usuario; admin con
      `?all=true` ve todo (incluye username via JOIN).
- [ ] Ownership en `getJobStatus` / `downloadFile` / `deleteJob`: si
      `job.user_id !== req.user.id` y no es admin → **404** (no 403, para no
      revelar existencia de jobs ajenos). Jobs huérfanos (`user_id NULL`) solo admin.
- [ ] `stats.controller.ts`: filtrar por `user_id` salvo admin.
- [ ] `certificate.controller.ts`: sustituir `requireAdminKey` por
      `requireRole('admin')`; guardar `emitido_por_user_id`. Retirar
      `CERT_ADMIN_KEY` de env y del middleware viejo.
- [ ] Tests: ownership (dueño ok, ajeno 404, admin ok), stats filtradas.

### Fase 3 — Backend: gestión de usuarios + enforcement (½ día)
- [ ] `controllers/user.controller.ts` + rutas `/users` (solo admin): listar,
      crear (password temporal + `must_change_password`), editar rol/estado,
      reset de contraseña.
- [ ] Activar `requireAuth` global en `routes/index.ts` para TODO excepto
      `/health` y `/auth/login`. (Este es el "switch" final del backend.)

### Fase 4 — Frontend (1.5–2 días)
- [ ] `core/services/auth.service.ts`: login, logout, estado del usuario
      (signal), persistencia del token (`localStorage`), decodificar rol/expiración.
- [ ] Interceptor HTTP: adjunta `Authorization: Bearer`; ante 401 → logout +
      redirigir a `/login`.
- [ ] `features/login/`: formulario (Material), manejo de credenciales
      inválidas, flujo de cambio de contraseña obligatorio.
- [ ] Guards: `authGuard` (todas las rutas), `adminGuard` (`/certificados`,
      `/usuarios`, stats globales). Quitar del frontend el prompt de `X-Admin-Key`.
- [ ] Header (`app.component`): nombre del usuario logueado + menú (cambiar
      contraseña, cerrar sesión).
- [ ] `features/jobs/`: vista "Mis trabajos" — tabla paginada (operación,
      archivo, estado, fecha, descargar/borrar). Admin: toggle "ver todos" con
      columna usuario.
- [ ] `features/users/` (solo admin): CRUD de usuarios.
- [ ] Ruta `/login` pública en `app.routes.ts`; el resto detrás del guard.

### Fase 5 — Despliegue y verificación (½ día)
- [ ] Ejecutar `003_users.sql` en QA; definir `JWT_SECRET` y
      `ADMIN_INITIAL_PASSWORD` en el `.env` del servidor.
- [ ] Crear los usuarios reales del equipo con el admin seed y forzar cambio de
      contraseña.
- [ ] Verificación E2E en QA: login → comprimir → ver en "Mis trabajos" →
      descargar; usuario B no ve/descarga el job de A; admin ve todo; emisión de
      certificado registra `emitido_por_user_id`.
- [ ] Actualizar `CLAUDE.md` (endpoints, regla "toda ruta salvo /health y
      /auth/login exige JWT") y `Docs/SEGUIMIENTO_SESION.md`.

**Estimación total: ~5 días.**

---

## 5. Riesgos y puntos a vigilar

- **Descarga desde el navegador:** hoy la descarga puede ser un link directo
  (`GET /jobs/:id/download`). Con auth por header, el frontend debe descargar
  vía HttpClient (blob) o usar un token de descarga de un solo uso — decidir en
  Fase 4 (propuesta: blob por HttpClient, más simple).
- **Jobs en curso durante el deploy:** la columna nullable y el poller sin
  cambios hacen que el deploy no interfiera con jobs pendientes.
- **`JWT_SECRET` débil o compartido:** generar 64+ bytes aleatorios por
  entorno; nunca reutilizar entre QA y producción.
- **Módulo certificados:** al retirar `X-Admin-Key`, avisar a TI que el acceso
  pasa a ser su cuenta con rol admin (coordinar antes del deploy a QA).
- **Expiración de archivos (24h) no cambia:** el historial "Mis trabajos"
  mostrará jobs cuyo archivo ya expiró — deshabilitar el botón de descarga
  cuando `expires_at` pasó.
