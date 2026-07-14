# PLAN — Firma dibujada (el usuario elige: digital, dibujada o combinada)

> **Estado:** APROBADO para implementación (decisiones cerradas el 2026-07-13).
> **Fecha:** 2026-07-13 · **Rama prevista:** `feat/firma-dibujada` (desde `feat/pdf-operations`)

---

## 1. Objetivo

Ampliar la herramienta **Firmar** (`/tools/sign`) para que el usuario elija entre
**tres modos**:

1. **Digital (certificado)** — lo que existe hoy: firma criptográfica con
   .pfx/.p12 vía pyHanko (invisible, sin apariencia).
2. **Dibujada** — el usuario dibuja su firma en un lienzo (tinta negra o azul,
   o sube una imagen), la coloca sobre el PDF (una o varias páginas) y el
   worker la estampa como imagen.
3. **Combinada** — dibujada **+** digital: el worker estampa el dibujo en las
   páginas elegidas y después aplica la firma criptográfica con el certificado
   sobre el documento ya estampado (la imagen queda protegida por la firma).

### Aclaración importante (debe verse en la UI)

La firma **dibujada sola NO es criptográfica**: es una imagen estampada,
equivalente a firmar a mano un papel escaneado. La UI debe mostrar una nota:
*"La firma dibujada es visual. Para validez criptográfica usa el modo digital
o el combinado."*

### Fuera de alcance (v1)

- Guardar firmas dibujadas del usuario para reutilizar (requiere cuentas).
- Apariencia visible del campo de firma criptográfico de pyHanko
  (`stamp_style`): el modo combinado se resuelve estampando primero con
  pikepdf y firmando después — más simple y permite multi-página (ver §2).
- Posiciones distintas por página (v1: misma posición normalizada en todas
  las páginas elegidas).

---

## 2. Decisiones de diseño (cerradas)

| Tema | Decisión | Notas |
|---|---|---|
| `operation_type` | **Reusar `'sign'`** con `operation_params.mode = 'certificate' \| 'drawn' \| 'combined'` → **sin migración** (la columna es ENUM en `schema.sql:11`) | Alternativa descartada: nuevo valor ENUM (migración innecesaria) |
| Modo combinado | **Estampar (pikepdf) → firmar (pyHanko)** secuencialmente en el mismo job. La firma criptográfica es la actual (invisible) y cubre el documento ya estampado, por lo que el dibujo queda íntegro bajo la firma | Un campo de firma visible de pyHanko solo puede vivir en UNA página; estampar-luego-firmar permite dibujo en varias páginas + validez criptográfica |
| Multi-página | Campo `pages` estilo extract/rotate: `'all'` o `"1,3-5"`. La misma posición normalizada se aplica en cada página | Posiciones por página: v2 |
| Tinta | **Negra y azul** — selector en el canvas (`signature_pad.penColor`); solo frontend | |
| Captura del dibujo | Librería **`signature_pad`** (MIT, ~10KB, sin deps) sobre un `<canvas>` | Canvas a mano: descartado |
| Alternativa al dibujo | Permitir **subir imagen** PNG/JPG de la firma (mismo campo) | |
| Envío de la imagen | **Multipart, campo `signature`** (PNG exportado del canvas como Blob) — reutiliza multer y la limpieza de archivos existente | Base64 en body: descartado |
| Colocación | Reutilizar el **preview PDF existente** (`previewDoc` en `tools.component.ts`): el usuario navega a una página de referencia y **arrastra/redimensiona un recuadro** con la firma; aparte elige el alcance (esta página / todas / rango) | |
| Sistema de coordenadas | **Normalizadas 0–1** relativas a la página (`x`, `y`, `w`) desde la esquina **inferior-izquierda** (convención PDF); el worker multiplica por el MediaBox de CADA página (así funciona con tamaños mixtos). Altura por aspect ratio de la imagen | |
| Estampado en worker | **pikepdf + Pillow**: imagen como XObject (con SMask para alfa) + operador `Do` en el content stream de cada página elegida | pikepdf ya es dependencia; solo se agrega Pillow |
| Fondo del dibujo | Canvas **transparente** → PNG con alfa | |
| Política de la imagen | **Igual que el certificado**: se borra del disco tras usarse y se elimina la ruta de `operation_params` (patrón `_destroy_credentials`, `sign.py:74`). En combinado se destruyen imagen Y certificado | |

---

## 3. Arquitectura / flujo

```
/tools/sign (selector de 3 modos)
   │
   ├─ certificate ──► flujo actual sin cambios
   │                   POST /api/v1/pdf/sign (file + cert + password)
   │
   ├─ drawn ──────┐
   │              │ 1. dibuja en signature_pad (negra/azul) o sube imagen
   └─ combined ───┤ 2. coloca el recuadro sobre el preview + elige páginas
                  │    (esta / todas / rango "1,3-5")
                  │ 3. POST /api/v1/pdf/sign  multipart:
                  │      file      = PDF
                  │      signature = PNG del canvas
                  │      mode      = 'drawn' | 'combined'
                  │      pages, x, y, w          (normalizados 0–1)
                  │      cert + password          (solo combined)
                  │      outputName
                  │ 4. backend valida e inserta job operation_type='sign'
                  │    params={mode, signature_path, pages, x, y, w,
                  │            cert_path?, cert_password?}
                  │ 5. poller → handle_sign → dispatch por params.mode
                  │      drawn:    estampa (pikepdf+Pillow) → output
                  │      combined: estampa → firma pyHanko sobre el
                  │                resultado → output
                  └─ 6. GET /jobs/:id / download — sin cambios
```

---

## 4. Cambios por componente

### 4.1 Frontend (`frontend/src/app/features/tools/`)

- `tools.component.ts`:
  - `signMode = signal<'certificate' | 'drawn' | 'combined'>('certificate')`.
  - Estado nuevo: `signImageBlob`, `signInk: 'black' | 'blue'`,
    `signPlacement = {x, y, w}`, `signPagesScope: 'current' | 'all' | 'range'`
    + `signPagesRange: string`.
  - `runSign()` valida según modo:
    - `certificate`: cert + password (actual).
    - `drawn`: imagen + colocación.
    - `combined`: imagen + colocación + cert + password.
- `tools.component.html`:
  - Selector de modo (tres tarjetas: 🔐 Digital / ✍️ Dibujada / 🔐✍️ Combinada,
    con la nota legal en Dibujada).
  - Panel de dibujo: canvas `signature_pad`, selector de tinta (negra/azul),
    botones *Limpiar* / *Deshacer*, opción *Subir imagen*.
  - Overlay de colocación sobre el preview (recuadro arrastrable/redimensionable)
    + selector de alcance de páginas (esta / todas / rango).
  - En combinado se muestran ADEMÁS los campos de certificado actuales.
- `core/services/api.service.ts`: `signPdf(...)` acepta modo y campos nuevos
  (un solo método, FormData condicional).
- `core/tool-catalog.ts:53`: descripción → "Firma con certificado digital,
  dibuja tu firma, o ambas."
- `package.json`: `signature_pad`.

### 4.2 Backend (`backend/src/`)

- `middlewares/upload.middleware.ts`: la ruta de sign acepta el campo
  `signature` (además de `file` y `cert`); mimetype `image/png` / `image/jpeg`
  **solo** para ese campo; límite propio (**2MB**).
- `controllers/pdf-operation.controller.ts` → `signPdf`:
  - `mode ∈ {certificate (default), drawn, combined}`.
  - `certificate`: validaciones actuales sin cambios.
  - `drawn`: exigir `signature`; magic bytes PNG (`\x89PNG`) o JPEG (`\xFF\xD8`);
    `x, y, w ∈ [0,1]`; `pages` = `'all'` o rango válido (reusar el parser de
    extract/rotate).
  - `combined`: validaciones de `drawn` **+** las de `certificate`.
  - params según modo (ver flujo §3).
- Sin cambios en modelo ni rutas.

### 4.3 Worker (`python-worker/`)

- `requirements.txt`: **Pillow**.
- `app/operations/sign.py`:
  - `handle_sign` despacha por `params.mode`:
    - `certificate` (default): código actual intacto.
    - `drawn` → `_stamp_drawn_signature(...)` → output.
    - `combined` → `_stamp_drawn_signature(...)` a un archivo temporal →
      firma pyHanko (código actual) tomando ese temporal como entrada → output.
  - `_stamp_drawn_signature`:
    1. Abrir imagen con Pillow (**re-encode a PNG** → neutraliza payloads;
       `Image.MAX_IMAGE_PIXELS` contra decompression bombs; máx 2000px ancho).
    2. Abrir PDF con pikepdf; resolver `pages` a índices (error claro si
       fuera de rango).
    3. Por cada página: rect en puntos con SU MediaBox (`x·W, y·H, w·W`,
       altura por aspect ratio; **clamp** dentro de la página).
    4. Incrustar XObject (una sola vez, referenciado desde cada página; SMask
       para alfa) y añadir `Do` al content stream.
  - `finally`: borrar `signature_path` (y en combinado también `cert_path`)
    y `JSON_REMOVE` de `signature_path`, `cert_path`, `cert_password`.
- `comprepdf-worker.spec` (PyInstaller / deploy QA): incluir Pillow — ojo con
  los binarios de PIL igual que pasó con las DLLs de mysql (ver memoria de
  deploy QA).

### 4.4 Base de datos

- **Ninguno** (se reusa `operation_type='sign'`).

---

## 5. Seguridad

- La imagen de la firma es un dato **sensible** (biométrico conductual):
  mismo tratamiento que el certificado — se destruye tras usarse, nunca se
  loggea la ruta ni se conserva en `operation_params`.
- Re-encode obligatorio con Pillow antes de incrustar (nunca meter los bytes
  del usuario tal cual dentro del PDF).
- Validar magic bytes de la imagen en backend Y worker (defensa en capas,
  como ya se hace con `%PDF-`).
- Límites: imagen ≤ 2MB y ≤ 2000px de ancho; `Image.MAX_IMAGE_PIXELS`.
- En **combinado**, el orden estampar→firmar es obligatorio: cualquier
  modificación posterior a la firma la invalidaría. La firma criptográfica
  final protege también la imagen estampada.
- El PDF de entrada mantiene la validación `%PDF-` actual.

---

## 6. Fases y estimación

| # | Fase | Contenido | Est. |
|---|---|---|---|
| 1 | Worker | `_stamp_drawn_signature` (multi-página) + dispatch de 3 modos + tests | 1–1.5 d |
| 2 | Backend | upload middleware + validaciones por modo + tests | 0.5 d |
| 3 | Frontend | selector 3 modos + signature_pad (tinta negra/azul) + overlay de colocación + alcance de páginas | 1.5 d |
| 4 | E2E + QA | flujo completo local (docker) → deploy a QA (rebuild worker exe con Pillow) | 0.5 d |
| | **Total** | | **~4 días** |

---

## 7. Pruebas

- **Worker (`pytest`)**:
  - Estampa en página 1, última, `'all'` y rango `"1,3-5"`; tamaños de página
    mixtos (posición correcta en cada MediaBox).
  - Coords en las 4 esquinas; PNG con transparencia; clamp cuando el recuadro
    se sale; imagen no-imagen (rechazo); página fuera de rango.
  - **Combinado**: el output tiene la estampa Y una firma criptográfica
    válida (verificar con pyHanko `validation`); el orden estampar→firmar no
    invalida la firma.
  - Limpieza: PNG (y cert en combinado) borrados; `operation_params` sin
    `signature_path` / `cert_path` / `cert_password`.
- **Backend**: `drawn` sin `signature` → 400; `combined` sin cert o sin
  password → 400; coords fuera de [0,1] → 400; `pages` inválido → 400;
  magic bytes inválidos → 400; `certificate` sigue igual.
- **E2E**: por cada modo: dibujar/colocar → descargar → abrir el PDF y
  verificar la firma en las posiciones elegidas; combinado además con panel
  de firmas de un lector PDF; con `outputName` personalizado; tinta azul.

---

## 8. Decisiones tomadas (histórico)

Resueltas el 2026-07-13:

1. **Modo combinado**: SÍ, incluido en v1 (vía estampar→firmar).
2. **Tinta**: negra y azul.
3. **Multi-página**: SÍ, incluido en v1 (`pages: 'all'` o rango; misma
   posición en todas).
