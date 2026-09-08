# PLAN CONCEPTUAL — "Estudio PDF": un solo espacio de trabajo en vez de 15 herramientas sueltas

> **Estado:** Fases 0 y 1 IMPLEMENTADAS · Fase 3 parcial · Fases 2 y 4 pendientes.
> **Fecha:** 2026-07-31 · **Rama:** `feat/dashboard`
> **Origen:** feedback de usuarios en producción — "la separación de funciones y la
> descarga de resultados separados es más una molestia que un avance".
>
> El detalle de qué quedó hecho y qué falta está en **§7 Fases**.

---

## 1. El problema en una frase

**Hoy cada operación es una exportación.** Rotar dos páginas y luego resaltar un
párrafo obliga a: subir → esperar → descargar → volver a subir → esperar →
descargar. El usuario paga el coste de un *ciclo completo de archivo* por cada
micro-decisión. Eso es exactamente lo que Acrobat no hace y lo que iLovePDF sí.

Los usuarios no piden "más herramientas". Piden **dejar de manejar archivos
intermedios**.

---

## 2. Diagnóstico del estado actual

Basado en `frontend/src/app/core/tool-catalog.ts`, `app.routes.ts`,
`features/tools/tools.component.ts` (955 líneas), `features/editor/`,
`features/organize/` y `backend/src/controllers/pdf-operation.controller.ts`.

1. **15 herramientas = 15 destinos.** `TOOL_CATALOG` define 15 entradas y el home
   (`features/home/home.component.ts`) las pinta como 15 tarjetas equivalentes.
   La estructura de la app *es* un menú de utilidades, no un editor.
2. **Cada herramienta reinicia el contexto.** `/tools/:tool`, `/editor`,
   `/organizar` y `/compress` son componentes distintos, cada uno con su propio
   `<input type=file>`, su propio estado y su propio botón de descarga. Nada se
   comparte entre ellos: ni el archivo, ni el zoom, ni la página en la que estabas.
3. **El resultado solo existe como descarga.** El contrato de todos los endpoints
   es *multipart in → job → blob out* (`createPdfJob`,
   `pdf-operation.controller.ts:19-70`). No hay forma de decir "aplica esto sobre
   lo que acabas de generar". El disco del usuario es el único pegamento entre
   dos operaciones.
4. **Ya hay tres editores parciales que no se hablan.** `pdf-editor.component`
   (marcado tipo Acrobat, 705 líneas, canvas + capa de elementos),
   `pdf-organize.component` (miniaturas arrastrables) y `sign-placement.component`
   (colocación visual de la firma) resuelven **el mismo problema** — mostrar el
   PDF y dejar interactuar sobre él — tres veces, por separado.
5. **`tools.component.ts` es un cajón de sastre.** Un componente con el estado de
   11 herramientas mezclado (`SingleFileField`, `splitFile`, `extractFile`,
   `rotateFile`, `protectFile`, `unlockFile`, `signFile`, `convertFile`…). Crece
   linealmente con cada operación nueva; es el síntoma técnico del mismo problema
   conceptual.
6. **Lo que ya está bien y se reutiliza tal cual:** `shared/pdf-preview/`
   (servicio pdf.js, `pdf-thumb`, `pdf-page-grid`, `page-ranges`), la operación
   `organize` del worker (reordena + elimina + rota **en un solo job**), la
   operación `pdf_edit` (acepta N elementos de N tipos en un solo job), el
   ownership de jobs y la descarga como blob autenticado.

---

## 3. La tesis: Acrobat en vez de iLovePDF

| | Modelo iLovePDF (hoy) | Modelo Acrobat (propuesto) |
|---|---|---|
| Unidad central | La **herramienta** | El **documento** |
| Punto de entrada | Elegir función → subir archivo | Abrir archivo → decidir sobre la marcha |
| Feedback | Descargar y abrir en otro visor | En pantalla, inmediato |
| Nº de descargas | 1 por operación | **1 por sesión** |
| Estructura mental | Catálogo de servicios | Espacio de trabajo con herramientas |

La consecuencia práctica: **abrir un PDF deja de ser un paso previo y pasa a ser
el estado normal de la aplicación.** Las funciones se convierten en verbos que se
ejercen sobre el documento abierto.

---

## 4. Propuesta: el Estudio

Una ruta nueva `/estudio` que aloja el documento abierto y casi todas las
operaciones. No sustituye a los endpoints; sustituye a la navegación.

### 4.1 Anatomía de la pantalla

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ComprePDF   informe-2026.pdf ×  contrato.pdf ×   [+]        ⟲ ⟳   👤 Rhay    │  ← pestañas de documento
├──────────────────────────────────────────────────────────────────────────────┤
│ [Páginas] [Marcado] [Insertar] [Firmar] [Proteger] [Exportar]                 │  ← grupos de herramientas
│ ─────────────────────────────────────────────────────────────────────────────│
│  ✏️Texto  🖍️Resaltar  ⌫Tapar  ▭Recuadro  ➤Flecha  ☁️Nube  🏷️Sello  🖼️Imagen  │  ← cinta contextual del grupo activo
├────────────┬──────────────────────────────────────────────┬──────────────────┤
│  PÁGINAS   │                                              │   PROPIEDADES    │
│            │                                              │                  │
│ ┌────┐ 1   │            ┌────────────────────┐            │  Elemento: Sello │
│ │▓▓▓▓│     │            │                    │            │  Texto  [......] │
│ └────┘     │            │                    │            │  Color  ■ ■ ■ ■  │
│ ┌────┐ 2 ⟳ │            │      PÁGINA 3      │            │  Fecha  [x]      │
│ │▓▓▓▓│     │            │                    │            │                  │
│ └────┘     │            │                    │            ├──────────────────┤
│ ┌────┐ 3 ●│            │                    │            │  CAMBIOS (4)     │
│ │▓▓▓▓│     │            └────────────────────┘            │  • Rotar p.2     │
│ └────┘     │                                              │  • Eliminar p.7  │
│ ┌────┐ 4   │        ⊟ 100% ⊞      ◀ 3 / 12 ▶              │  • 2 resaltados  │
│ │▓▓▓▓│     │                                              │  • 1 sello       │
│ └────┘     │                                              │  [Deshacer todo] │
├────────────┴──────────────────────────────────────────────┴──────────────────┤
│  4 cambios sin aplicar                    [Aplicar]  [Guardar y descargar ▾]  │  ← única salida a disco
└──────────────────────────────────────────────────────────────────────────────┘
```

Tres zonas fijas, una sola barra de acción:

- **Izquierda — Páginas.** Reemplaza `/organizar`. Arrastrar reordena, `Supr`
  elimina, botón rota, `+` inserta desde otro archivo, selección múltiple habilita
  "extraer" y "dividir aquí". Es a la vez navegador y editor de estructura.
- **Centro — Lienzo.** El `pdf-editor` actual, ampliado: además de dibujar
  elementos, es donde se colocan la firma y los sellos, y donde se ve el efecto de
  todo lo demás.
- **Derecha — Propiedades + Pila de cambios.** Contextual al elemento
  seleccionado, y debajo el historial de lo pendiente. La pila de cambios es la
  pieza que sustituye a "descargar para ver si quedó bien".

### 4.2 Taxonomía: qué entra y qué no

El criterio no es "qué es popular", sino **qué le pasa al documento**:

**A. Ediciones — mutan el documento y te dejas dentro del Estudio**
`organize` · `rotate` · `extract` (como "quedarse con la selección") · `merge`
(reencuadrado como **"Insertar páginas desde otro archivo"** en una posición
concreta) · `pdf_edit` (texto, imagen, tapar, todo el marcado de Fases 1-2) ·
`sign` (dibujada o certificado).

**B. Exportaciones — producen un artefacto distinto y terminan la sesión**
`compress` ("Guardar optimizado") · `protect` ("Guardar con contraseña") ·
`split` ("Dividir en varios archivos" → ZIP) · `pdf_to_word` · `pdf_to_excel` ·
`translate`. Todas viven bajo un único menú **Exportar ▾**, con el diálogo de
opciones que ya tienen hoy.

**C. Importaciones — te traen al Estudio**
`convert` (Office/imagen → PDF) deja de ser una herramienta y pasa a ser el
comportamiento por defecto al soltar un `.docx` en el Estudio. `unlock` pasa a ser
lo que ocurre cuando abres un PDF con contraseña: te pide la clave y entras.

**D. Fuera del Estudio (autoría, no edición)**
`forms` (diseñador de AcroForm) se queda como módulo propio; el PDF generado se
puede "abrir en el Estudio". Certificados y usuarios siguen en administración.

Esta taxonomía es la respuesta directa a la queja: **hoy todo es categoría B.**
Al mover A dentro del Estudio, la descarga aparece una sola vez, al final.

### 4.3 El principio que lo hace posible: edición diferida con coalescencia

Si cada clic disparara un job, el Estudio sería más lento que hoy. La regla:

1. **Todo cambio es local primero.** Rotar, reordenar, eliminar y todo el marcado
   se representan en memoria y se pintan en el canvas al instante. El servidor no
   se entera.
2. **Los cambios se agrupan por tipo.** Reordenar + rotar + eliminar ya caben en
   **un solo job `organize`**; todo el marcado cabe en **un solo job `pdf_edit`**.
   Las operaciones del worker ya aceptan lotes — no hay que tocarlas.
3. **Se materializan en puntos de descarga (*flush*)**, no antes:
   - al **Exportar** o descargar,
   - al pedir una operación que necesita los bytes reales (comprimir, firmar con
     certificado, proteger, traducir, convertir a Word/Excel),
   - o al pulsar **Aplicar** explícitamente.
4. **El orden se respeta.** La pila se materializa como una **cadena de jobs en
   secuencia**; solo se fusionan cambios adyacentes del mismo tipo. Un resaltado
   hecho *después* de reordenar no puede aplicarse *antes*.

Efecto: una sesión típica (reordenar, borrar una página, resaltar, firmar,
descargar) pasa de **5 jobs + 5 descargas** a **2-3 jobs + 1 descarga**, y el
usuario percibe respuesta instantánea en todo lo demás.

---

## 5. Lo que hay que habilitar en el backend

Tres cambios, ninguno grande. **El worker no se toca.**

### 5.1 Encadenar jobs sin pasar por el disco del usuario

Es el habilitador crítico. Hoy todo endpoint exige `multipart/form-data`. Se
añade una segunda forma de entrada:

```
POST /api/v1/pdf/rotate
  (hoy)  multipart: file=<binario>
  (nuevo) json:     { "sourceJobId": "<uuid>", "degrees": 90, "pages": "2" }
```

El backend resuelve el archivo `output` de `sourceJobId`, **valida ownership con
la misma regla de siempre** (ajeno o huérfano → 404, nunca 403) y lo registra como
`original` del job nuevo (copia o *hardlink* dentro de `uploads_data`). A partir de
ahí el flujo es idéntico: fila `pending` → poller → handler. `createPdfJob`
absorbe el caso en su firma actual.

Esto elimina de golpe la subida y la descarga intermedias — la queja literal del
usuario — con un cambio localizado en un solo controlador.

### 5.2 Agrupar la cadena en una sesión

Columna nueva `session_id` (uuid, nullable) en `compression_jobs`, y opcionalmente
`parent_job_id`. Sirve para dos cosas:

- **`/mis-trabajos` deja de llenarse de ruido**: el listado muestra **un renglón
  por sesión** (el último job), con los intermedios plegados.
- **Deshacer del lado servidor**: volver a un job anterior de la sesión es
  simplemente cambiar a qué `jobId` apunta el documento de trabajo.

*Alternativa más barata para la Fase 0:* mantener la cadena solo en el cliente
(una lista de `jobId`) y no tocar el esquema. Se pierde el plegado en
`/mis-trabajos` y el deshacer entre recargas. **Recomendación: hacer `session_id`
desde el principio** — es una columna, y sin ella el historial se vuelve
inservible en cuanto el Estudio se use de verdad.

### 5.3 Limpieza de intermedios

Los outputs intermedios multiplican el uso de `outputs_data`. `cleanup.service.ts`
debe purgar los jobs intermedios de una sesión **al cerrarse la sesión** o antes
de las 24h habituales, conservando solo el final. Sin esto, el Estudio triplica el
almacenamiento sin dar nada a cambio.

---

## 6. Impacto en la navegación (IA)

El home deja de ser un catálogo de 15 tarjetas iguales:

```
┌───────────────────────────────────────────────────────────┐
│                                                           │
│         Arrastra un documento para empezar                │
│         ┌─────────────────────────────────┐               │
│         │      ⬆  Abrir documento          │              │
│         │   PDF, Word, Excel, PowerPoint   │              │
│         └─────────────────────────────────┘               │
│                                                           │
│   RECIENTES                                               │
│   📄 informe-2026.pdf      hace 10 min    [Abrir]         │
│   📄 contrato-v3.pdf       ayer           [Abrir]         │
│                                                           │
│   ACCIONES RÁPIDAS      Unir · Dividir · Comprimir ·      │
│                         PDF a Word · Traducir · Formularios│
└───────────────────────────────────────────────────────────┘
```

- **Primario:** abrir un documento → Estudio.
- **Secundario:** "acciones rápidas" para quien sabe exactamente qué quiere y no
  necesita el Estudio (el flujo de hoy, en un solo paso).
- **Compatibilidad:** las rutas `/tools/:tool`, `/editor` y `/organizar` **siguen
  funcionando** (enlaces guardados, manual de usuario, capacitaciones). Se retiran
  del menú, no del router, y solo cuando el Estudio cubra su caso.

---

## 7. Fases

Cada fase es entregable y aporta valor por sí sola.

**Fase 0 — Fundamentos invisibles. ✅ HECHA.** `sourceJobId` en todos los endpoints
de operación (`middlewares/source-job.middleware.ts`), `sources` ordenado para
merge, `session_id` + `parent_job_id` en `compression_jobs` (migración
`012_estudio_sesiones.sql`), plegado de sesiones en `/mis-trabajos`
(`LATEST_OF_SESSION`) y purga de intermedios superados en `cleanup.service.ts`.
*Sin cambio visible de UI.* **El worker no se tocó.**
→ *Aceptación:* encadenar rotate → pdf_edit → organize por API sin descargar nada
en medio, respetando ownership. Cubierto por 19 pruebas en
`tests/middlewares/source-job.middleware.test.ts` (incluyendo que un job ajeno u
huérfano da 404 y no copia el archivo) y **verificado en QA contra MySQL y worker
reales** (§10.5). *(La cadena de aceptación original decía "compress" en el último
paso; se cambió a `organize` porque compress no funciona en QA por falta de
Ghostscript — ver §10.5.)*

**Fase 1 — Estudio v1 (el 80% del valor). ✅ HECHA.** Ruta `/estudio` con el shell
de tres paneles. El visor con capa de edición se extrajo a
`shared/pdf-markup/` y ahora lo comparten `/editor` y el Estudio (se acabó la
duplicación). Pila de cambios con coalescencia `organize` + `pdf_edit`, deshacer
por pasos y **una sola descarga**.
→ *Aceptación:* abrir un PDF, reordenar, borrar una página, rotar otra, resaltar,
poner un sello y descargar **una vez**. La lógica está cubierta por 20 pruebas en
`features/estudio/workspace.service.spec.ts`.
→ *Pendiente de esta fase:* pestañas de documento (van con la Fase 2).

**Fase 2 — Estructura del documento. ⬜ PENDIENTE en la UI.** El backend ya la
soporta (`sources` en merge permite insertar páginas en cualquier posición); falta
la interfaz: insertar desde otro archivo, extraer selección a pestaña nueva y
multi-documento.
→ *Aceptación:* combinar dos PDF sin salir del Estudio ni descargar el intermedio.

**Fase 3 — Menú Exportar y Firmar. 🟨 PARCIAL.** Hecho: `compress`, `protect`,
`split`, `pdf_to_word`, `pdf_to_excel` y `translate` como diálogos del Estudio,
distinguiendo salida encadenable (sigue siendo el documento de trabajo) de salida
terminal (se descarga y el documento no cambia).
→ *Pendiente:* `sign` dentro del Estudio (absorbiendo `sign-placement.component`),
`unlock` implícito al abrir un PDF protegido y `convert` implícito al soltar un
Office. `tools.component.ts` sigue intacto.

**Fase 4 — Nueva IA y retiro. 🟨 PARCIAL.** Hecho: el home antepone "Abrir el
Estudio" y degrada las 15 tarjetas a "Acciones rápidas"; hay entrada de menú.
→ *Pendiente:* documentos recientes, dropzone en el propio home y actualización
del manual de usuario. Las rutas por herramienta siguen vivas a propósito.

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| El Estudio se percibe **más lento** que la herramienta suelta | Edición diferida: nada toca el servidor hasta el *flush*. Las acciones rápidas del home conservan el flujo de un paso. |
| **Complejidad para el usuario ocasional** que solo quiere comprimir | Acciones rápidas en el home + rutas antiguas vivas. El Estudio es la puerta ancha, no la única. |
| **Almacenamiento** disparado por outputs intermedios | Limpieza por sesión (§5.3), coalescencia que reduce el nº de jobs, expiración 24h existente. |
| **Pérdida de trabajo** al recargar con cambios sin aplicar | Persistir la pila en `localStorage` por documento + aviso `beforeunload`. |
| Documentos grandes: render y miniaturas en cliente | Miniaturas perezosas (ya existe `pdf-thumb`), virtualización del panel de páginas, tope de páginas para el render simultáneo. |
| **Regresión en `/mis-trabajos`** por el ruido de intermedios | Va en Fase 0, antes de que el Estudio genere cadenas. |
| Operaciones lentas (traducción LLM, Office COM) bloqueando el Estudio | Siempre categoría B (exportación asíncrona con progreso), nunca inline en la pila. |
| El Estudio se convierte en otro `tools.component.ts` gigante | Un componente contenedor + un componente por panel + un servicio `WorkspaceService` dueño del documento y la pila. La pila de cambios es el único estado compartido. |

---

## 9. Decisiones abiertas (para la reunión)

1. **`session_id` desde Fase 0 o cadena solo en cliente.** Recomendación: hacerlo
   ya (§5.2).
2. **¿Multi-documento con pestañas en Fase 1 o esperar a Fase 2?** Recomendación:
   una sola pestaña en Fase 1; las pestañas nacen con "insertar/extraer".
3. **Nombre visible.** "Estudio", "Espacio de trabajo", "Editor". El plan usa
   *Estudio* porque "editor" ya significa otra cosa en el producto.
4. **¿Se retiran las rutas viejas o se quedan indefinidamente?** Recomendación:
   quedan al menos dos versiones, por el manual y las capacitaciones.
5. **Alcance del deshacer:** ¿solo la pila local, o también revertir a un job
   anterior ya materializado?

---

## 10. Notas de la implementación

### 10.1 Dos bugs preexistentes que aparecieron por el camino

Ambos estaban en la ruta del cambio, así que se corrigieron:

1. **`POST /pdf/unlock` no tenía multer.** `router.post('/pdf/unlock', unlockPdf)`
   sin `upload.single('file')`: `req.file` y `req.body.password` llegaban siempre
   vacíos, así que la herramienta "Desbloquear" respondía **400 en todos los
   casos**. Ahora monta el mismo pipeline que sus hermanas.
2. **`POST /compress` rechazaba `outputName`.** `validateCompressionOptions` usa
   un esquema Joi y Joi **prohíbe las claves desconocidas por defecto**: mandar el
   nombre de salida (que el frontend envía desde `compress.component.ts`) devolvía
   `"outputName" is not allowed`. El esquema ahora declara `outputName`,
   `sessionId` y `sourceJobId`.

### 10.2 Dos trampas de QA que el Estudio habría pisado

Las dos son propias del entorno QA y no se ven en desarrollo:

1. **`crypto.randomUUID` no existe en QA.** QA se sirve por HTTP plano
   (`192.168.7.222:8090`), así que `window.isSecureContext === false` y
   `randomUUID` vale `undefined` — ya rompió el editor de formularios el
   2026-07-16. El Estudio lo usaba para el `sessionId`. Peor aún: el backend
   valida el `sessionId` contra el patrón UUID, así que un fallback que no
   generase un UUID real habría hecho que **las sesiones se descartaran en
   silencio** y nada agrupara la cadena. Ahora hay un único `shared/uuid.ts`
   (`newId`) con fallback sobre `crypto.getRandomValues` y los bits de versión y
   variante en su sitio, cubierto por `shared/uuid.spec.ts`.
2. **El rate-limit ahogaba el sondeo de estado.** El límite global es de 100
   peticiones / 15 min por IP y el Estudio sondea `GET /jobs/:id` cada 1,2 s
   mientras el worker trabaja: una sesión con varias operaciones encadenadas
   agotaba la cuota y el usuario veía "Too many requests" a mitad de su trabajo.
   `GET /jobs/:id` tiene ahora su propio limitador holgado (1500/15 min); el
   resto de rutas mantiene el tope de 100.

### 10.3 Verificación en navegador (Playwright, sin backend)

Con `ng serve` + sesión inyectada en localStorage (el guard es solo client-side).
Confirmado sobre el manual de 14 páginas:

- Abrir documento, tres paneles, miniaturas y página renderizadas.
- Girar / eliminar / reordenar arrastrando: instantáneo y con **cero peticiones**
  a la API (`performance.getEntriesByType('resource')` vacío) — la edición
  diferida hace lo que promete.
- La pila de cambios acumula ("1 eliminada · 1 girada · Páginas reordenadas") y
  el pie cuenta los pendientes.
- **La invariante, en vivo:** pulsar "Resaltar" con páginas pendientes disparó
  UNA sola `POST /pdf/organize` (los 3 cambios fundidos en un job); al fallar,
  el resaltado **no** se añadió y lo pendiente **no** se perdió.
- Marcado: resaltado, sello y recuadro se colocan y renderizan; los 3 se cuentan
  como un único cambio pendiente.
- Diálogo de exportación con su validación (sin contraseña, botón bloqueado).
- **Regresión de `/editor`** (código en producción que refactoricé): carga,
  marcado, panel de propiedades, zoom, navegación y **dibujo libre** (13 puntos
  capturados y polyline renderizada) siguen funcionando sobre el lienzo
  compartido.

La prueba cazó tres defectos, ya corregidos y con test de regresión:

1. La **navegación de páginas quedaba bajo la barra fija** de guardado. Se movió
   arriba, junto al zoom (donde la pone Acrobat): además de arreglarlo, elimina
   la geometría frágil de "restar píxeles al `100vh`".
2. Se mostraba el **volcado técnico de Angular** ("Http failure response for …:
   0 Unknown Error"). Ahora `status 0` se traduce a "No se pudo contactar con el
   servidor…".
3. El estado **"Aplicando cambios…" se quedaba colgado** tras un fallo, dando a
   entender que la operación seguía en marcha.

### 10.4 Qué queda sin verificar

- **El SQL del plegado de sesiones no se ha ejecutado contra MySQL.** No hay
  instancia levantada en el entorno de desarrollo (`ECONNREFUSED` en 3306), así
  que `LATEST_OF_SESSION` —una subconsulta correlacionada dentro del camino
  DISTINCT + join 1:N + paginación de TypeORM— solo está probado por lectura. Los
  casos están escritos en `tests/models/job.model.integration.test.ts` y **se
  saltan solos sin BD**: hay que correrlos donde sí la haya antes de dar la Fase 0
  por buena.
*(Resuelto: todo lo que faltaba se verificó en QA — ver §10.5.)*

### 10.5 Verificación en QA (31/07/2026) — lo que faltaba, ya probado

Desplegado en QA (migración 012 + backend + frontend; **el worker no se tocó**).
E2E autenticado contra la API real, **20/20 comprobaciones OK**:

- **Encadenado real:** `rotate` (con archivo) → `pdf_edit` (`sourceJobId`, sin
  subir nada) → `organize` (`sourceJobId`), los tres procesados por el worker de
  verdad; el PDF final se descargó y es válido.
- **El SQL del plegado, que era la duda principal**, funciona contra MySQL real:
  la cadena de 3 pasos ocupa **un solo renglón**, muestra el último, dice
  "3 pasos" y los intermedios no se listan.
- **Ownership:** encadenar sobre un job ajeno responde 404 (no 403).
- **Salida no encadenable:** intentar seguir editando el ZIP de un split se
  rechaza con 400 y el mensaje correcto.
- **Integridad en BD:** 0 hijos con padre inexistente, 0 padres de otra sesión, y
  los 165 jobs anteriores intactos con `session_id` NULL.
- **Los dos bugs preexistentes, corregidos en producción:** `/pdf/unlock` ya crea
  su job (antes 400 siempre) y `/compress` acepta `outputName`.
- **En el navegador de QA** (contexto HTTP inseguro, donde `crypto.randomUUID` es
  literalmente `undefined`): el Estudio abre, acumula cambios sin tocar el
  servidor, y "Aplicar" cierra el ciclo completo — un `organize`, luego un
  `pdf_edit` encadenado — con el documento recargado y la página **realmente
  girada**. El fallback de `shared/uuid.ts` era imprescindible.

Los artefactos del E2E se limpiaron: QA quedó en 163 jobs / 17 usuarios, idéntico
al estado previo.

**Hallazgo ajeno a este trabajo (ya resuelto, ver §10.6):** `compress` **nunca
había funcionado en QA**. Ghostscript no estaba instalado y el worker invocaba el
comando `gs` (`app/compression/ghostscript.py`), que en Windows sería `gswin64c`
→ `[WinError 2]`. Se descubrió al encadenar un compress, y la prueba de que no era
una regresión es que **en todo el historial de QA solo existía un job `compress`:
el de esa misma prueba**.

### 10.6 Compresión: instalada y verificada en QA (31/07/2026)

**Instalación.** El instalador NSIS de Ghostscript 10.07.1 **se cuelga en la
sesión 0** (SYSTEM, sin escritorio) incluso con `/S` y `/rl HIGHEST`: se queda el
proceso vivo sin crear nada. La salida fue **extraerlo con el 7-Zip que ya hay en
QA** (`7z x gs10071w64.exe -o"C:\Program Files\gs\gs10.07.1"`, 656 archivos);
Ghostscript es relocalizable y funciona desde el árbol extraído.

**Que el worker lo encuentre.** Se añadió `C:\Program Files\gs\gs10.07.1\bin` al
PATH de máquina con la API de .NET (**no `setx /M`**, que trunca a 1024 caracteres
y puede corromper el PATH) y se dejó un alias `gs.exe` junto a `gswin64c.exe`,
porque el worker desplegado —un exe congelado— sigue invocando `gs`. Para
recargar el PATH hace falta reiniciar el worker: se añadió **`restart-worker.bat`**
al share, que faltaba (`update-backend-worker.bat` no sirve: haría el swap de una
carpeta `_new` inexistente y dejaría el worker roto).

**Arreglo durable en el código** (va con la próxima reconstrucción del worker, y
entonces el alias deja de hacer falta): `resolve_ghostscript()` busca
`GHOSTSCRIPT_PATH` → `gswin64c`/`gswin32c` en Windows → `gs`, y un
`FileNotFoundError` se traduce a un mensaje que dice qué falta en vez del
`[WinError 2]` crudo. Cubierto por 7 pruebas nuevas.

**Verificado en QA, 11/11 comprobaciones**, en los tres niveles y también
encadenado (la ruta del Estudio), más la exportación "Comprimir" desde la UI:

| PDF de prueba | low | medium | high |
|---|---|---|---|
| Con imágenes (15,2 MB) | **23 KB** (99,8%) | 57 KB (99,6%) | 163 KB (98,9%) |
| Solo texto (35 KB) | 33 KB (7%) | 33 KB (7%) | **55 KB (crece)** |

La segunda fila no es una avería: en un PDF sin imágenes no hay nada que
remuestrear y `pdfwrite` lo reescribe entero. Vale la pena avisarlo en la UI
antes de que un usuario comprima un documento de texto en calidad alta y se
encuentre con un archivo más grande.

### 10.7 Qué sigue sin verificar

- **El arreglo de `resolve_ghostscript()` no está desplegado**: el worker de QA
  es un exe congelado y sigue llevando el código viejo. Hoy funciona por el alias
  `gs.exe`; el código nuevo entra con la próxima reconstrucción con PyInstaller.
- **La purga de intermedios** (`cleanIntermediateJobs`) no se ha visto correr:
  necesita una sesión con pasos superados de más de `INTERMEDIATE_JOB_TTL_MINUTES`
  (120 min por defecto) y el servicio de limpieza corre cada hora.
- **Fase 2 y el resto de la Fase 3** (insertar/extraer, multi-documento, firma
  dentro del Estudio) no están implementadas.

### 10.8 Al desplegar

- Aplicar `database/migrations/012_estudio_sesiones.sql` **antes** de subir el
  backend: sin las columnas, todo job falla al insertar.
- `INTERMEDIATE_JOB_TTL_MINUTES` (opcional, 120 por defecto) controla cuánto
  sobreviven los pasos intermedios; es también la ventana de "deshacer".
- **Ghostscript** debe estar en el host del worker para que `compress` funcione
  (ver §10.6). En un host nuevo: instalarlo y, si no queda en el PATH, definir
  `GHOSTSCRIPT_PATH` con la ruta al ejecutable.

---

## 11. Cómo se mide el éxito

- **Descargas por documento trabajado:** de ~N (una por operación) a **1**.
- **% de sesiones con ≥2 operaciones sobre el mismo documento** — hoy es
  prácticamente 0 porque el producto lo castiga; es el indicador de que el cambio
  funcionó.
- **Tiempo desde abrir el archivo hasta la descarga final.**
- **Reducción de `tools.component.ts`** (955 líneas) y desaparición de los tres
  visores de PDF paralelos.
- Desaparición de la queja que originó este plan.
