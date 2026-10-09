# Web de CC Mallorca

Web de espeleología con un editor **al estilo FrontPage**: el cliente edita
directamente encima de la página, sin panel de administración. Mismas secciones
y **mismo aspecto** que su web actual (fondo negro, columna de 900px, cabecera
por sección, menú dorado en Book Antiqua, fotos en mosaico con el autor en la
esquina), pero funcionando en móvil y tablet.

- **Sin base de datos:** todo el contenido vive en un único `content.json`.
- **Sin compilación:** HTML, CSS y JavaScript planos.
- **Sin dependencias:** un único `api.php` en PHP plano, sin librerías.
- **A prueba de errores:** el cliente puede cambiar textos y fotos, pero
  el servidor **no le deja tocar la estructura** de la web (ver más abajo).

Repositorio dedicado únicamente a esta web — sin mezclar con ningún otro
proyecto.

---

## Publicar en cPanel (hosting real del cliente)

Funciona en **PHP** (7.0 o superior, cualquier cPanel lo tiene). No hay
que crear ninguna app ni reiniciar nada: son archivos que se copian a la
carpeta del subdominio.

### 1. Subdominio de revisión

**Dominios → Dominios** → crea `beta.ccmallorca.net` con su propia
carpeta. Fíjate en la **raíz del documento** que propone cPanel
(normalmente `/home/TU_USUARIO/beta.ccmallorca.net`). Si es otra, cambia
`DEPLOYPATH` en [`.cpanel.yml`](./.cpanel.yml).

### 2. Traer el código con Git Version Control

**Archivos → Git™ Version Control → Create Repository**:
- Clone URL: `https://github.com/hidagar/ccmallorca-web.git`
- Repository Path: `repositories/ccmallorca-web`

Entra en el repo → **Pull or Deploy** → elige la rama → **"Deploy HEAD
Commit"**. El `.cpanel.yml` copia la carpeta `public/` y
`content.default.json` a la carpeta del subdominio.

### 3. Primera visita: contraseñas

La primera vez que se abre la web se crea sola la carpeta de datos
**`/home/TU_USUARIO/ccmallorca-data`** (fuera de la parte pública):
`content.json`, `config.json` y `backups/`.

Las contraseñas iniciales se generan al azar y se apuntan en
**`ccmallorca-data/CONTRASENAS.txt`** (ábrelo con el Administrador de
archivos). Entra con la de administrador y cámbialas desde el botón
**«🔑 Contraseñas»** del panel azul.

Si prefieres elegirlas antes de la primera visita, copia
`config.local.example.php` como `config.local.php` en la carpeta del
subdominio y pon ahí las contraseñas (o una carpeta de datos distinta).

### 4. SSL

**Seguridad → Let's Encrypt™ SSL** (o AutoSSL) para `beta.ccmallorca.net`.

### Actualizar tras cambios en el código

**Git™ Version Control** → el repo → **Pull or Deploy** → **"Update from
Remote"** y luego **"Deploy HEAD Commit"**. El despliegue solo copia el
código: **no toca** las fotos que ha subido el cliente (`uploads/`) ni
sus textos (`ccmallorca-data/`).

### Qué va dónde

| Dónde | Qué | ¿Se pisa al desplegar? |
|---|---|---|
| `beta.ccmallorca.net/` | `index.html`, `app.js`, `styles.css`, `api.php`… | Sí (es el código) |
| `beta.ccmallorca.net/uploads/` | fotos y PDF que sube el cliente | No |
| `~/ccmallorca-data/` | textos (`content.json`), contraseñas, copias de seguridad | No |

> **Límites de subida:** `public/.user.ini` sube el límite de PHP a 25 MB
> (los PDF pueden pesar hasta 20 MB). Si el hosting lo ignora, ajústalo en
> **Software → MultiPHP INI Editor** (`upload_max_filesize` y
> `post_max_size`).

### Probarla en tu ordenador

```bash
php -S localhost:8000 -t public
```

y abre <http://localhost:8000>. Los datos se crean en `~/ccmallorca-data`
(las contraseñas, en `~/ccmallorca-data/CONTRASENAS.txt`).

---

## Cómo la edita el cliente

1. Entra en la web y pulsa **«Editar la web»** (abajo, en el pie).
2. Escribe la contraseña.
3. Aparece una barra amarilla arriba y todo lo editable se marca con
   un recuadro de puntos:
   - **Textos:** clic encima y escribir. Al seleccionar texto sale una
     barrita con negrita, cursiva, lista y enlace.
   - **Fotos:** botones «Cambiar foto» / «Poner foto» / «Quitar foto».
   - **Grupos de fotos (mosaicos):** debajo de cada mosaico hay una lista
     donde puede añadir **varias fotos a la vez**, cambiarlas de orden,
     quitarlas y escribir el autor y la descripción de cada una.
   - **Documentos PDF:** botón «Añadir documento PDF» / «Cambiar PDF» /
     «Quitar PDF» — ya no hace falta el FTP para subir anexos e informes.
4. Pulsa **«Guardar cambios»** (botón verde) o **Ctrl+S**.

Los visitantes pueden ampliar cualquier foto con un clic y pasar a la
siguiente con las flechas (o deslizando el dedo en el móvil).

También puede **«Descartar»** para volver a la última versión guardada, o
**«Salir»** para dejar el modo edición. Si intenta cerrar la pestaña con
cambios sin guardar, el navegador le avisa.

---

## Modo administrador (para ti, el desarrollador)

Entrando con la **contraseña de administrador** (la de «Administrador» en `CONTRASENAS.txt`), en
lugar de la del cliente, la barra superior se vuelve **azul** y aparecen los
controles de estructura. Es la misma web, encima de la propia página (WYSIWYG):

- **Administrar páginas** (panel azul arriba de cada página):
  - Cambiar el nombre que sale en el menú
  - Mover la página a izquierda/derecha en el menú
  - **Crear página nueva** / **Borrar esta página**
- **Cajones** (cada bloque tiene una barra encima):
  - **↑ Subir** / **↓ Bajar** para reordenar
  - **🗑 Borrar** el cajón
- **Añadir un cajón nuevo** al final de la página: Título, Texto, Foto
  grande, Grupo de fotos (mosaico), o Documento PDF
- **Media columna**: dos cajones seguidos de media columna quedan uno al
  lado del otro (p. ej. «Resumen | Summary» en Artículos)
- **Disposición de cada grupo de fotos**: en fila (misma altura, sin
  recortar), mosaico «2 apiladas + 1 alta» a la derecha o a la izquierda,
  o rejilla con pies de foto
- **Estilo de la página**: fondo negro (como la portada) u hoja blanca
  (como Artículos)
- **Imagen de cabecera** (la tira de 900×60 de cada sección). Si no se
  pone, se genera una automática con el nombre de la sección. El cliente
  puede cambiarla, pero solo el admin ponerla o quitarla.

Cuando guardas como admin, se guarda la **estructura entera** (endpoint
`api.php?r=structure`). Lo que hagas aquí define qué puede editar luego el cliente:
él solo cambia los valores (textos y fotos) de los cajones que tú has puesto,
nunca su disposición. Así se lo dejas montado como te pida y él solo rellena.

> El servidor **no confía** en lo que llega del admin: reconstruye el
> contenido validando cada tipo de cajón, generando ids únicos y limpiando
> todo el HTML. Ni el cliente ni el admin pueden inyectar scripts.

### Cambiar la contraseña

En modo administrador, panel azul → **«🔑 Contraseñas»**: eliges la del
cliente o la tuya y escribes la nueva. No hace falta terminal ni cPanel.

Si olvidas la de administrador: borra `~/ccmallorca-data/config.json`
con el Administrador de archivos y abre la web. Se generan contraseñas
nuevas en `CONTRASENAS.txt` (los textos y las fotos no se tocan).

---

## Qué puede y qué no puede tocar

Esto no depende del navegador: el servidor **fusiona** los cambios sobre el
contenido existente en lugar de aceptar lo que le llegue, así que la
estructura está garantizada desde el servidor.

| Puede | No puede |
|---|---|
| Cambiar cualquier texto | Crear o borrar páginas |
| Cambiar el título y subtítulo | Añadir o quitar secciones de una página |
| Sustituir y quitar fotos | Cambiar el menú o el orden |
| Añadir/quitar fotos de la galería | Meter HTML o scripts (se limpian al guardar) |
| Subir/cambiar/quitar documentos PDF | Subir archivos que no sean imágenes o PDF |
| Poner enlaces, negrita, cursiva y listas | |

Además, cada vez que guarda se hace una **copia de seguridad** automática en
`ccmallorca-data/backups/` (se conservan las 30 últimas).

---

## Cómo se importa el contenido real

Es una herramienta para **tu ordenador** (necesita Node, la web no). Se
genera el contenido en local y luego se suben `content.json` a
`~/ccmallorca-data/` y las fotos a `uploads/` del subdominio:

```bash
bash mirror-original.sh --fotos   # descarga ccmallorca.net
node import-original.mjs --dry    # prueba, no toca nada
CCM_DATA_DIR=./salida CCM_UPLOADS_DIR=./salida/uploads node import-original.mjs
```

El importador entiende el HTML que genera FrontPage:

- Convierte la codificación **Windows-1252** a UTF-8 (acentos y `ñ` correctos).
- Quita `<font>`, tablas de maquetación, comentarios `webbot`, scripts y estilos.
- **Descarta** menús de navegación, avisos de copyright del pie e imágenes
  decorativas (flechas, líneas, botones, contadores) — salvo que la página
  tenga contenido real de verdad, aunque el nombre del archivo parezca de
  navegación (p. ej. `mapa_del_web.htm` en este sitio tiene un artículo).
- Saca el título de cada página del `<h1>` cuando el `<title>` es sólo el
  nombre del archivo (`Articulos.htm`).
- Une las líneas que FrontPage partía en el código para no romper los párrafos.
- Copia las fotos reales a `uploads/` y las referencia en el contenido.

Con `--dry` deja el resultado en `content.imported.json` para revisarlo sin
tocar nada. Ya se han importado 3 páginas reales (`Artículos`, `Opinión`,
`Mapa del web`); faltan `Principal`, `Reportajes` e `Informes` — sus páginas
tienen un aviso de "pendiente de trasladar" hasta que se envíen esos `.htm`.

---

## Estructura del contenido

`content.json` tiene tres partes: `site` (título, subtítulo, pie, email),
`menu` (las secciones) y `pages`. Cada página tiene `title`, `intro` y una
lista de `blocks`, cada uno con un `id` fijo y un tipo:

| Tipo | Qué es | Qué edita el cliente |
|---|---|---|
| `heading` | Subtítulo de sección | el texto |
| `text` | Párrafos, listas | el contenido con formato |
| `image` | Una foto con pie | la foto y el pie |
| `gallery` | Rejilla de fotos | las fotos y sus pies |
| `document` | Un PDF descargable | el PDF y su nombre visible |

Para **añadir una sección nueva** hay que editar `content.default.json` (y el
`content.json` del servidor) — es una tarea de desarrollo, no del cliente.
