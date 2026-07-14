# PLAN — Módulo de Certificados Digitales (CA interna de la cooperativa)

> **Estado:** BORRADOR para discusión — no iniciado.
> **Fecha:** 2026-07-09 · **Rama prevista:** `feat/certificados` (desde `feat/pdf-operations`)

---

## 1. Objetivo

Que la cooperativa pueda **emitir certificados digitales personales (.pfx)** a sus
empleados, firmados por una **CA raíz interna** ("Coopaspire CA"), para usarlos en
la operación de firma de ComprePDF. Las firmas resultantes se verán **válidas y
confiables en todas las PCs de la cooperativa** (una vez distribuida la raíz).

### Alcance confirmado
- **Solo TI emite** los certificados (v1 protegida con clave de administrador;
  sin login por empleado todavía).
- Validez **interna** (flujo documental de la coop). NO sustituye certificados
  acreditados por INDOTEL para validez legal frente a terceros (Ley 126-02).

### Fuera de alcance (v1)
- Autoservicio por empleado / login AD.
- CRL/OCSP publicado (la revocación en v1 es registro interno + reemisión).
- Integración con HSM (la clave CA vive cifrada en disco del servidor).

---

## 2. Decisiones de diseño (propuestas — discutir)

| Tema | Propuesta | Alternativa |
|---|---|---|
| Dónde se genera el cert | **Worker Python** (lib `cryptography`, ya es dependencia de pyHanko) | Backend Node con `node-forge` |
| Mecanismo | **Reutilizar el patrón de jobs** (`operation_type='issue_cert'`): la descarga del .pfx sale gratis por `GET /jobs/:id/download` | Endpoint síncrono nuevo con su propia descarga |
| Custodia clave CA | Clave privada **cifrada en disco del worker** (passphrase en env `CA_KEY_PASSPHRASE`); nunca en el repo ni en la DB | HSM / DPAPI (v2) |
| Protección del módulo | Header `X-Admin-Key` contra env `ADMIN_API_KEY` (middleware nuevo) | Login completo (v2) |
| Clave del empleado | RSA **3072** bits, generada por el worker, empaquetada en .pfx | RSA 2048 / ECDSA P-256 |
| Contraseña del .pfx | **Autogenerada** (fuerte, se muestra una sola vez a TI al emitir) | TI la escribe en el formulario |
| Vigencia cert empleado | **2 años** (configurable en el formulario) | 1 año |
| Vigencia CA raíz | 10 años | 20 años |
| Descarga del .pfx | **Una sola vez** + expira a las 24h como cualquier output (regla existente) | Re-descargable mientras no expire |

**Regla de seguridad clave:** el `.pfx` emitido y su contraseña se tratan igual
que en la firma: el archivo expira/se borra a las 24h y la contraseña NUNCA se
persiste (se genera, se devuelve en la respuesta del job, y no se guarda).
Si TI la pierde, se revoca y se emite de nuevo.

---

## 3. Arquitectura

```
TI (frontend /admin/certificados)
   │  X-Admin-Key
   ▼
Backend: POST /api/v1/certificates ──► INSERT compression_jobs
                                        (operation_type='issue_cert',
                                         operation_params={nombre, correo, depto, vigencia})
                                              │
                                              ▼ (poll)
Worker: handle_issue_cert ── cryptography ──► genera clave + cert firmado por CA
   │                                          empaqueta .pfx (contraseña autogenerada)
   ├─► INSERT certificates (registro/auditoría: serial, sujeto, vigencia, estado)
   └─► register_output(.pfx)  →  TI descarga por GET /jobs/:id/download
```

- La **CA raíz** se crea UNA VEZ con un script CLI (`scripts/ca-init.py` dentro de
  python-worker), que produce:
  - `ca/ca_key.pem` (cifrada con `CA_KEY_PASSPHRASE`) — se queda en el servidor.
  - `ca/ca_cert.pem` + `ca/coopaspire-ca.cer` (DER) — el `.cer` es el que se
    distribuye a las PCs (GPO / instalación manual).
- El worker es el ÚNICO proceso que toca la clave CA (mismo aislamiento que la firma).
- La contraseña del .pfx viaja al backend en el registro del job **una sola vez**
  vía el campo `result` del job (visible en `GET /jobs/:id` hasta que TI la copie)
  — discutir si prefieren otro canal.

### Tabla nueva `certificates` (migración `002_certificates.sql`)
```sql
id CHAR(36) PK · serial VARCHAR(40) UNIQUE · subject_name VARCHAR(255)
subject_email VARCHAR(255) · department VARCHAR(100) NULL
not_before DATETIME · not_after DATETIME
status ENUM('active','revoked','expired') DEFAULT 'active'
revoked_at DATETIME NULL · revoke_reason VARCHAR(255) NULL
job_id CHAR(36) FK → compression_jobs · created_at TIMESTAMP
```
(El .pfx NO se guarda aquí; solo metadatos para auditoría y revocación.)

### Endpoints nuevos (todos detrás de `X-Admin-Key`)
```
POST   /api/v1/certificates            # Emitir (nombre, correo, depto, vigenciaAños) → jobId
GET    /api/v1/certificates            # Listar emitidos (filtro por estado)
POST   /api/v1/certificates/:id/revoke # Marcar revocado (motivo)
GET    /api/v1/certificates/ca         # Descargar el .cer de la raíz (para instalar confianza)
```

---

## 4. Fases y tareas

### Fase 0 — Bootstrap de la CA (½ día)
- [ ] `python-worker/scripts/ca_init.py`: genera clave CA (RSA 4096, cifrada) +
      certificado raíz autofirmado (CN="Coopaspire CA", O="Coopaspire", C=DO,
      basicConstraints CA:TRUE, keyUsage keyCertSign+cRLSign, 10 años).
- [ ] Config worker: `CA_DIR`, `CA_KEY_PASSPHRASE` en `.env.example`.
- [ ] Documentar respaldo de la clave CA (copia cifrada fuera del servidor).

### Fase 1 — Backend (1 día)
- [ ] Migración `database/migrations/002_certificates.sql`.
- [ ] Middleware `admin.middleware.ts` (`X-Admin-Key` vs `ADMIN_API_KEY`; 401 si falta/incorrecta).
- [ ] `certificate.controller.ts`: emitir (inserta job `issue_cert` SIN archivo de
      entrada — revisar que `createPdfJob`/validaciones toleren 0 originales),
      listar, revocar, descargar `.cer` de la CA.
- [ ] Rutas en `routes/index.ts` bajo `/certificates`.

### Fase 2 — Worker (1 día)
- [ ] `app/operations/issue_cert.py`: `handle_issue_cert(job, cursor)` —
      genera clave RSA 3072 → CSR interno → cert firmado por la CA
      (keyUsage digitalSignature+nonRepudiation, EKU emailProtection+clientAuth,
      serial aleatorio) → serializa PKCS#12 con contraseña autogenerada (16+ chars)
      → `register_output(.pfx)` → INSERT en `certificates` → contraseña al `result`.
- [ ] Registrar `'issue_cert'` en `HANDLERS` del poller.
- [ ] Manejo de errores sin filtrar material criptográfico en logs (patrón de sign.py).
- [ ] Tests pytest: cadena válida (verificar cert emitido contra la raíz),
      vigencia, .pfx abre con la contraseña, serial único.

### Fase 3 — Frontend (1–1½ días)
- [ ] Sección "Certificados" (ruta `/admin/certificados`, NO listada en el home
      público ni en tool-catalog): campo clave de administrador (se guarda en
      sessionStorage), formulario de emisión, polling del job, panel de resultado
      con contraseña visible una sola vez + botón de descarga del .pfx.
- [ ] Tabla de emitidos (estado, vigencia) + acción revocar + descarga del `.cer` raíz.
- [ ] Estilo con los tokens del rediseño (sheet cards, inputs nativos).

### Fase 4 — Confianza en las PCs + integración firma (½ día)
- [ ] `Docs/INSTALAR_CONFIANZA_CA.md`: instalar `coopaspire-ca.cer` en
      "Entidades de certificación raíz de confianza" (manual y por GPO), y
      configurar Adobe Acrobat para confiar en el almacén de Windows
      (`bValidateUsingWindowsStore`) — también por GPO/registro.
- [ ] (Opcional, discutir) En `handle_sign`: si el cert fue emitido por nuestra CA
      y figura **revocado** en la tabla, rechazar la firma.

### Fase 5 — Verificación E2E + deploy QA (½ día)
- [ ] E2E local: emitir cert → firmar un PDF con ese .pfx vía `/pdf/sign` →
      abrir en Acrobat con la raíz instalada → firma válida y de confianza.
- [ ] Revocar → (si se hizo la Fase 4 opcional) la firma se rechaza.
- [ ] Deploy a QA: rebuild worker (PyInstaller) + backend + frontend; correr
      `ca_init.py` en QA (o copiar la CA de dev — **discutir**: ¿misma CA en
      dev/QA/prod o una por entorno? Recomendado: una sola CA "real" en prod,
      CA desechable en dev/QA).

**Total estimado: ~4–5 días de trabajo.**

---

## 5. Puntos abiertos para discutir

1. **Contraseña del .pfx**: ¿autogenerada (propuesto) o la escribe TI al emitir?
2. **Canal de entrega al empleado**: TI descarga el .pfx y lo entrega — ¿cómo?
   (en persona/share cifrado; el correo NO es recomendable con la contraseña junta).
3. **¿Una CA por entorno o una sola?** (propuesto: CA desechable en dev/QA,
   CA definitiva solo en prod, generada por TI en el servidor final).
4. **Datos del sujeto del certificado**: ¿incluir cédula? ¿cargo? (queda visible
   en el panel de firmas de Acrobat).
5. **Chequeo de revocación al firmar** (Fase 4 opcional): ¿lo incluimos en v1?
6. **`ADMIN_API_KEY`**: ¿es suficiente para arrancar, o TI quiere ya usuarios
   individuales para saber QUIÉN emitió cada certificado? (v1 registra el hecho,
   no el emisor).
7. **Distribución de la raíz**: ¿la coop tiene Active Directory con GPO
   disponible, o será instalación manual por PC?
