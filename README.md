# Web de CC Mallorca

Web de espeleología con un editor **al estilo FrontPage**: el cliente edita
directamente encima de la página, sin panel de administración. Mismas secciones
que su web actual, pero con diseño moderno y funcionando en móvil y tablet.

- **Sin base de datos:** todo el contenido vive en un único `content.json`.
- **Sin compilación:** HTML, CSS y JavaScript planos.
- **Sin dependencias:** el servidor sólo usa módulos nativos de Node.
- **A prueba de errores:** el cliente puede cambiar textos y fotos, pero
  el servidor **no le deja tocar la estructura** de la web (ver más abajo).

Repositorio dedicado únicamente a esta web — sin mezclar con ningún otro
proyecto.

---

## Publicar en cPanel (hosting real del cliente)

Este repositorio es **público**, así que cPanel puede clonarlo sin pedir
usuario ni token.

### 1. Subdominio de revisión

**Dominios → Dominios** → crea `beta.ccmallorca.net` como subdominio, con
su propio directorio (no compartas el "document root" con el dominio
principal, para no tocar la web en producción).

### 2. Traer el código con Git Version Control

**Archivos → Git™ Version Control → Create Repository**:
- Clone URL: `https://github.com/hidagar/ccmallorca-web.git`
- Repository Path: `repositories/ccmallorca-web`

Al clonar, entra en el repo y en "Pull or Deploy" pulsa **"Deploy HEAD
Commit"** (ejecuta el `.cpanel.yml` de este repo, que solo sirve para que
Passenger se reinicie solo en cada despliegue).

### 3. Crear la app Node con Setup Node.js App

**Software → Setup Node.js App → Create Application**:
- **Node.js version**: la más reciente disponible; el código está escrito
  en CommonJS puro y probado desde **Node 11 en adelante**, así que
  funciona aunque el hosting solo ofrezca versiones antiguas
- **Application mode**: Production
- **Application root**: `repositories/ccmallorca-web`
- **Application URL**: el subdominio `beta.ccmallorca.net`
- **Application startup file**: `server.js`
- **Environment variables**:
  - `CCM_DATA_DIR` = una ruta **fuera** de `repositories/`, por ejemplo
    `/home/TU_USUARIO/ccmallorca-data` (así el contenido y las fotos que
    suba el cliente nunca se pierden al actualizar el código)
  - `CCM_PASSWORD` = la contraseña del **cliente** (solo cambia textos y fotos)
  - `CCM_ADMIN_PASSWORD` = **tu** contraseña de administrador (cambia la
    estructura: crear/borrar páginas, añadir cajones, cabeceras…). Si no la
    pones, se genera una al azar y aparece en el log de arranque de la app.

Guarda, pulsa **"Run NPM Install"** (no hay dependencias, pero cPanel lo
pide para reconocer la app) y luego **"Start App"**.

### 4. SSL

**Seguridad → Let's Encrypt™ SSL** → emite certificado para
`beta.ccmallorca.net`.

### Actualizar tras cambios en el código

Desde **Git™ Version Control**, entra en el repo → **"Pull or Deploy"** →
**"Update from Remote"** y luego **"Deploy HEAD Commit"**. El `.cpanel.yml`
reinicia la app sola; si no lo hace, usa el botón **"Restart"** en
**Setup Node.js App**.

---

<details>
<summary>Alternativa: servidor propio con systemd + nginx (Linux/Ubuntu)</summary>

```bash
git clone https://github.com/hidagar/ccmallorca-web
cd ccmallorca-web
bash instalar-todo.sh LA_CONTRASEÑA_QUE_QUIERAS
```

Ese script lo hace **todo**: crea el servicio systemd (puerto 5002) y los
datos en `/var/www/ccmallorca-data`, pone la contraseña, **descarga
ccmallorca.net e importa sus textos y fotos**, configura nginx (validando y
deshaciendo el cambio si algo falla) y comprueba que todo responde.

Para instalarla con el contenido de ejemplo en lugar del real:

```bash
bash instalar-todo.sh CONTRASEÑA --sin-contenido
```

Paso a paso, si se prefiere hacerlo a mano:

```bash
bash setup.sh CONTRASEÑA          # servicio + datos
bash mirror-original.sh --fotos   # copia de la web actual
node import-original.mjs          # importar contenido real
sudo node patch-nginx.mjs         # configurar nginx
sudo nginx -t && sudo systemctl reload nginx
```

O añadir a mano el bloque de [`nginx-ccmallorca.conf`](./nginx-ccmallorca.conf)
dentro del `server { ... }` de tu configuración de nginx.

> **Importante:** el `client_max_body_size 12M;` es obligatorio. Sin él, nginx
> rechaza las fotos grandes con un error 413.

</details>

---

## Cómo la edita el cliente

1. Entra en la web y pulsa **«Editar la web»** (abajo, en el pie).
2. Escribe la contraseña.
3. Aparece una barra amarilla arriba y todo lo editable se marca con
   un recuadro de puntos:
   - **Textos:** clic encima y escribir. Al seleccionar texto sale una
     barrita con negrita, cursiva, lista y enlace.
   - **Fotos:** botones «Cambiar foto» / «Poner foto» / «Quitar foto».
   - **Galería:** además puede añadir y quitar fotos.
   - **Documentos PDF:** botón «Añadir documento PDF» / «Cambiar PDF» /
     «Quitar PDF» — ya no hace falta el FTP para subir anexos e informes.
4. Pulsa **«Guardar cambios»** (botón verde).

También puede **«Descartar»** para volver a la última versión guardada, o
**«Salir»** para dejar el modo edición. Si intenta cerrar la pestaña con
cambios sin guardar, el navegador le avisa.

---

## Modo administrador (para ti, el desarrollador)

Entrando con la **contraseña de administrador** (`CCM_ADMIN_PASSWORD`), en
lugar de la del cliente, la barra superior se vuelve **azul** y aparecen los
controles de estructura. Es la misma web, encima de la propia página (WYSIWYG):

- **Administrar páginas** (panel azul arriba de cada página):
  - Cambiar el nombre que sale en el menú
  - Mover la página a izquierda/derecha en el menú
  - **Crear página nueva** / **Borrar esta página**
- **Cajones** (cada bloque tiene una barra encima):
  - **↑ Subir** / **↓ Bajar** para reordenar
  - **🗑 Borrar** el cajón
- **Añadir un cajón nuevo** al final de la página: Título, Texto, Foto,
  Galería de fotos, o Documento PDF
- **Imagen de cabecera**: banner opcional arriba de cada página

Cuando guardas como admin, se guarda la **estructura entera** (endpoint
`/api/structure`). Lo que hagas aquí define qué puede editar luego el cliente:
él solo cambia los valores (textos y fotos) de los cajones que tú has puesto,
nunca su disposición. Así se lo dejas montado como te pida y él solo rellena.

> El servidor **no confía** en lo que llega del admin: reconstruye el
> contenido validando cada tipo de cajón, generando ids únicos y limpiando
> todo el HTML. Ni el cliente ni el admin pueden inyectar scripts.

### Cambiar la contraseña

En cPanel, desde el **Terminal** si está disponible, o si no, cambiando
temporalmente el `CCM_PASSWORD` en las variables de entorno de **Setup
Node.js App** y reiniciando — pero eso solo aplica en la primera instalación
(luego la contraseña vive cifrada en `config.json`, dentro de `CCM_DATA_DIR`).
Para cambiarla en caliente hace falta ejecutar:

```bash
# contraseña del cliente
CCM_DATA_DIR=/ruta/a/ccmallorca-data node server.js --set-password NUEVA
# tu contraseña de administrador
CCM_DATA_DIR=/ruta/a/ccmallorca-data node server.js --set-admin-password NUEVA
```

y reiniciar la app (botón "Restart" en Setup Node.js App, o
`sudo systemctl restart ccmallorca` en la instalación con systemd).

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
`CCM_DATA_DIR/backups/` (se conservan las 30 últimas).

---

## Cómo se importa el contenido real

`instalar-todo.sh` ya lo hace (en la instalación con systemd), pero se puede
repetir cuando se quiera:

```bash
bash mirror-original.sh --fotos   # descarga ccmallorca.net
node import-original.mjs --dry    # prueba, no toca nada
node import-original.mjs          # aplica de verdad
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
