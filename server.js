// Servidor de la web de CC Mallorca amb editor tipus FrontPage.
// Sense dependencies: nomes moduls natius de Node. CommonJS expressament
// (no .mjs) perque funcioni sense flags experimentals en versions antigues
// de Node com les que ofereixen alguns hostings compartits (cPanel/CloudLinux
// NodeJS Selector amb Node 11 o similar).
//
// Rutes publiques:
//   GET  /                 -> la web
//   GET  /content.json     -> contingut actual
//   GET  /uploads/<fitxer>  -> fotos pujades
// Rutes d'edicio:
//   GET  /api/session      -> { authenticated }
//   POST /api/login        -> { password }
//   POST /api/logout
//   PUT  /api/content      -> guarda el contingut (nomes valors, no estructura)
//   POST /api/upload       -> { name, data(base64) } -> { src }
//
// Variables d'entorn:
//   CCM_PORT      (5002) — o PORT, que es el que injecta cPanel/Passenger
//   CCM_DATA_DIR  (/var/www/ccmallorca-data)

const http = require('http')
const { readFile, writeFile, mkdir, copyFile, readdir, unlink, rename } = require('fs').promises
const { existsSync, createReadStream, statSync } = require('fs')
const path = require('path')
const crypto = require('crypto')

const HERE = __dirname
// cPanel/Passenger assigna el port amb la variable PORT; als nostres
// scripts de systemd fem servir CCM_PORT. Acceptem qualsevol de les dues.
const PORT = Number(process.env.PORT || process.env.CCM_PORT) || 5002
const DATA_DIR = process.env.CCM_DATA_DIR || '/var/www/ccmallorca-data'
const PUBLIC_DIR = path.join(HERE, 'public')
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
const CONTENT_FILE = path.join(DATA_DIR, 'content.json')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const BACKUP_DIR = path.join(DATA_DIR, 'backups')
// Els PDF poden pesar mes que les fotos (memories, anexos escanejats),
// aixi que el limit del cos de la peticio ha de ser mes gran que un PDF
// en base64 (que infla la mida original un ~33%).
const MAX_BODY = 40 * 1024 * 1024

// ---------------------------------------------------------------- utilitats

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
}

// Codificacio base64url manual: Node no la va afegir com a "encoding" natiu
// de Buffer fins la v15.7, i volem funcionar tambe en versions mes antigues.
function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64Url(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Buffer.from(s, 'base64')
}

function sendJson(res, code, obj, headers) {
  const body = JSON.stringify(obj)
  const finalHeaders = Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    headers || {}
  )
  res.writeHead(code, finalHeaders)
  res.end(body)
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function stripTags(s) {
  return String(s)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li',
  'h3', 'h4', 'blockquote', 'a',
])

// Neteja l'HTML del text ric: nomes etiquetes segures, nomes href a <a>.
function sanitizeHtml(html) {
  let out = String(html)
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  out = out.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, tag, attrs) => {
    const t = tag.toLowerCase()
    if (!ALLOWED_TAGS.has(t)) return ''
    if (match.startsWith('</')) return `</${t}>`
    if (t === 'br') return '<br>'
    if (t === 'a') {
      const m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
      let url = (m ? (m[2] || m[3] || m[4] || '') : '').trim()
      if (!/^(https?:\/\/|mailto:|#|\/|\.\/)/i.test(url)) url = ''
      return url
        ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">`
        : '<a>'
    }
    return `<${t}>`
  })

  return out.trim()
}

// Nomes acceptem imatges pujades, imatges incloses o URLs https.
function isSafeSrc(src) {
  if (typeof src !== 'string' || !src) return false
  if (src.includes('..') || src.includes('\\')) return false
  return /^uploads\/[\w.\-]+$/.test(src) || /^img\/[\w.\-/]+$/.test(src) || /^https:\/\/[^\s"'<>]+$/.test(src)
}

// ------------------------------------------------------------- dades i auth

async function ensureData() {
  await mkdir(UPLOADS_DIR, { recursive: true })
  await mkdir(BACKUP_DIR, { recursive: true })

  if (!existsSync(CONTENT_FILE)) {
    await copyFile(path.join(HERE, 'content.default.json'), CONTENT_FILE)
    console.log('Contingut inicial creat a', CONTENT_FILE)
  }

  if (!existsSync(CONFIG_FILE)) {
    const password = process.env.CCM_PASSWORD || 'mallorca'
    const salt = crypto.randomBytes(16).toString('hex')
    const config = {
      secret: crypto.randomBytes(32).toString('hex'),
      salt,
      passwordHash: hashPassword(password, salt),
    }
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
    console.log(`Configuracio creada. Contrasenya d'edicio: "${password}"`)
    console.log('Canvia-la amb: node server.js --set-password NOVA')
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex')
}

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
}

async function loadContent() {
  return JSON.parse(await readFile(CONTENT_FILE, 'utf8'))
}

function sign(value, secret) {
  return toBase64Url(crypto.createHmac('sha256', secret).update(value).digest())
}

function makeToken(secret) {
  const payload = toBase64Url(Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600 * 1000 })))
  return `${payload}.${sign(payload, secret)}`
}

function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return false
  const [payload, sig] = token.split('.')
  const expected = sign(payload, secret)
  if (sig.length !== expected.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false
  try {
    return JSON.parse(fromBase64Url(payload).toString()).exp > Date.now()
  } catch (e) {
    return false
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const kv = part.trim().split('=')
    const k = kv.shift()
    if (k === name) return decodeURIComponent(kv.join('='))
  }
  return null
}

async function isAuthed(req) {
  const cfg = await loadConfig()
  return verifyToken(readCookie(req, 'ccm_session'), cfg.secret)
}

// Darrere de cPanel/Passenger totes les connexions arriben com a
// 127.0.0.1: si fessim servir remoteAddress, els intents fallits de
// QUALSEVOL visitant comptarien contra el mateix comptador i 10 errors
// de qui fos bloquejarien el login de tothom durant 15 minuts. Passenger
// posa la IP real a X-Forwarded-For.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff) return String(xff).split(',')[0].trim() || 'unknown'
  return req.socket.remoteAddress || 'unknown'
}

// Limit d'intents de contrasenya per IP
const attempts = new Map()
function tooManyAttempts(ip) {
  const rec = attempts.get(ip)
  if (!rec) return false
  if (Date.now() - rec.first > 15 * 60 * 1000) {
    attempts.delete(ip)
    return false
  }
  return rec.count >= 10
}
function noteAttempt(ip) {
  const rec = attempts.get(ip)
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) attempts.set(ip, { first: Date.now(), count: 1 })
  else rec.count++
}

// ------------------------------------------------- fusio segura del contingut
// Nomes s'actualitzen VALORS de blocs que ja existeixen: aixi el client pot
// canviar textos i fotos pero no pot trencar l'estructura de la web.

function mergeContent(current, incoming) {
  const out = JSON.parse(JSON.stringify(current))

  if (incoming && typeof incoming.site === 'object' && incoming.site) {
    for (const key of ['title', 'subtitle', 'footer', 'email', 'telefon', 'adreca']) {
      if (typeof incoming.site[key] === 'string') {
        out.site[key] = stripTags(incoming.site[key]).slice(0, 300)
      }
    }
  }

  const pages = incoming && typeof incoming.pages === 'object' ? incoming.pages : {}
  for (const slug of Object.keys(pages)) {
    const page = pages[slug]
    const target = out.pages[slug]
    if (!target || !page) continue

    if (typeof page.title === 'string') target.title = stripTags(page.title).slice(0, 200)
    if (typeof page.intro === 'string') target.intro = sanitizeHtml(page.intro)

    for (const block of Array.isArray(page.blocks) ? page.blocks : []) {
      const dest = target.blocks.find((b) => b.id === (block && block.id))
      if (!dest) continue

      if (dest.type === 'heading' && typeof block.text === 'string') {
        dest.text = stripTags(block.text).slice(0, 200)
      }
      if (dest.type === 'text' && typeof block.html === 'string') {
        dest.html = sanitizeHtml(block.html)
      }
      if (dest.type === 'image') {
        if (isSafeSrc(block.src)) dest.src = block.src
        if (typeof block.alt === 'string') dest.alt = stripTags(block.alt).slice(0, 300)
        if (typeof block.caption === 'string') dest.caption = stripTags(block.caption).slice(0, 300)
        if (typeof block.credit === 'string') dest.credit = stripTags(block.credit).slice(0, 120)
      }
      if (dest.type === 'document') {
        if (isSafeSrc(block.src)) dest.src = block.src
        if (typeof block.label === 'string') dest.label = stripTags(block.label).slice(0, 200)
      }
      if (dest.type === 'gallery' && Array.isArray(block.images)) {
        dest.images = block.images
          .filter((im) => im && isSafeSrc(im.src))
          .slice(0, 80)
          .map((im) => ({
            src: im.src,
            alt: stripTags(im.alt || '').slice(0, 300),
            caption: stripTags(im.caption || '').slice(0, 300),
            credit: stripTags(im.credit || '').slice(0, 120),
          }))
      }
    }
  }

  return out
}

async function saveContentWithBackup(content) {
  // Copia de seguretat de l'anterior abans de sobreescriure
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(CONTENT_FILE, path.join(BACKUP_DIR, `content-${stamp}.json`))
    const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith('.json')).sort()
    for (const old of files.slice(0, Math.max(0, files.length - 30))) {
      await unlink(path.join(BACKUP_DIR, old)).catch(() => {})
    }
  } catch (e) {}
  // Escriptura atomica: primer a un fitxer temporal i despres rename.
  // Aixi, si el proces cau a mitja escriptura, el contingut del client
  // no queda corromput a mitges.
  const tmp = CONTENT_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(content, null, 2))
  await rename(tmp, CONTENT_FILE)
}

// ------------------------------------------- sincronitzacio de l'estructura
// El contingut del client viu a CCM_DATA_DIR i sobreviu als desplegaments;
// pero aixo vol dir que si afegim seccions o blocs nous a
// content.default.json, les instal·lacions ja desplegades no els veurien
// mai. En arrencar, fusionem al contingut existent tot allo del default
// que li falti (pagines, blocs, entrades de menu), sense tocar mai res
// del que el client ja ha escrit ni esborrar-li res.

function syncStructure(current, defaults) {
  let changed = false

  // Entrades de menu que falten, inserides mantenint l'ordre del default
  if (!Array.isArray(current.menu)) {
    current.menu = []
    changed = true
  }
  let menuInsertAt = 0
  for (const item of defaults.menu || []) {
    const idx = current.menu.findIndex((m) => m && m.slug === item.slug)
    if (idx === -1) {
      current.menu.splice(menuInsertAt, 0, JSON.parse(JSON.stringify(item)))
      menuInsertAt++
      changed = true
    } else {
      menuInsertAt = idx + 1
    }
  }

  if (!current.pages || typeof current.pages !== 'object') {
    current.pages = {}
    changed = true
  }

  for (const slug of Object.keys(defaults.pages || {})) {
    const defPage = defaults.pages[slug]
    const curPage = current.pages[slug]

    if (!curPage) {
      current.pages[slug] = JSON.parse(JSON.stringify(defPage))
      changed = true
      continue
    }

    if (!Array.isArray(curPage.blocks)) {
      curPage.blocks = []
      changed = true
    }

    // Blocs que falten, inserits just despres de l'ultim bloc conegut
    let insertAt = 0
    for (const defBlock of defPage.blocks || []) {
      const idx = curPage.blocks.findIndex((b) => b && b.id === defBlock.id)
      if (idx === -1) {
        curPage.blocks.splice(insertAt, 0, JSON.parse(JSON.stringify(defBlock)))
        insertAt++
        changed = true
      } else {
        insertAt = idx + 1
      }
    }
  }

  return changed
}

async function ensureStructureUpToDate() {
  try {
    const defaults = JSON.parse(await readFile(path.join(HERE, 'content.default.json'), 'utf8'))
    const current = await loadContent()
    if (syncStructure(current, defaults)) {
      await saveContentWithBackup(current)
      console.log('Estructura actualitzada amb els blocs nous del default.')
    }
  } catch (e) {
    console.error('No s\'ha pogut sincronitzar l\'estructura:', e.message)
  }
}

// ------------------------------------------------------------------- pujades

const IMAGE_SIGNATURES = [
  { ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.gif', test: (b) => b.slice(0, 3).toString('latin1') === 'GIF' },
  { ext: '.webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
]

const DOCUMENT_SIGNATURES = [
  // Un PDF pot portar unes poques bytes de brossa abans de "%PDF-"
  { ext: '.pdf', test: (b) => b.slice(0, 1024).includes('%PDF-') },
]

async function handleUpload(body) {
  const base64 = String(body.data || '').replace(/^data:[^;]+;base64,/, '')
  if (!base64) return { error: 'Falta el archivo' }

  let buf
  try {
    buf = Buffer.from(base64, 'base64')
  } catch (e) {
    return { error: 'El archivo no es válido' }
  }
  if (buf.length < 12) return { error: 'El archivo no es válido' }

  const wantsDocument = body.kind === 'document'
  const maxSize = wantsDocument ? 20 * 1024 * 1024 : 8 * 1024 * 1024
  if (buf.length > maxSize) {
    return {
      error: wantsDocument
        ? 'El PDF es demasiado grande (máximo 20 MB)'
        : 'La foto es demasiado grande (máximo 8 MB)',
    }
  }

  const signatures = wantsDocument ? DOCUMENT_SIGNATURES : IMAGE_SIGNATURES
  const match = signatures.find((s) => s.test(buf))
  if (!match) {
    return {
      error: wantsDocument
        ? 'El archivo no parece un PDF válido'
        : 'Solo se aceptan fotos JPG, PNG, GIF o WEBP',
    }
  }

  const base = stripTags(body.name || (wantsDocument ? 'documento' : 'foto'))
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || (wantsDocument ? 'documento' : 'foto')
  const filename = `${base}-${crypto.randomBytes(4).toString('hex')}${match.ext}`

  await writeFile(path.join(UPLOADS_DIR, filename), buf)
  return { src: `uploads/${filename}` }
}

// -------------------------------------------------------- fitxers estatics

function serveFile(res, filePath, opts) {
  const cache = opts && opts.cache
  try {
    const st = statSync(filePath)
    if (!st.isFile()) throw new Error('not a file')
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache',
    })
    createReadStream(filePath).pipe(res)
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('No encontrado')
  }
}

function safeJoin(root, unsafe) {
  const target = path.resolve(root, '.' + path.posix.normalize('/' + unsafe))
  return target.startsWith(path.resolve(root)) ? target : null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (e) {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

// ------------------------------------------------------------------ servidor

// Si l'app es serveix des d'un subdirectori (p. ex. ccmallorca.net/beta en
// lloc d'un subdomini propi), cal saber-ho per treure el prefix de la ruta.
// No sabem si Passenger ja el treu abans d'arribar aqui, aixi que ho fem
// nosaltres tambe: si CCM_BASE_PATH no hi es, no canvia res (comportament
// identic al d'abans).
const BASE_PATH = String(process.env.CCM_BASE_PATH || '').replace(/\/+$/, '')

function stripBasePath(pathname) {
  if (!BASE_PATH) return pathname
  if (pathname === BASE_PATH) return '/'
  if (pathname.indexOf(BASE_PATH + '/') === 0) return pathname.slice(BASE_PATH.length)
  return pathname
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const rawPathname = decodeURIComponent(url.pathname)

  // Sense la barra final (p. ex. /beta en lloc de /beta/), el navegador
  // resol malament els fitxers relatius (styles.css, app.js...) perque
  // els busca com si fossin germans de "beta" a l'arrel. Redirigim per
  // corregir la URL de la barra d'adreces abans de servir res.
  if (BASE_PATH && rawPathname === BASE_PATH) {
    res.writeHead(301, { Location: BASE_PATH + '/' + url.search })
    return res.end()
  }

  const pathname = stripBasePath(rawPathname)

  try {
    // --- API ---
    if (pathname === '/api/session') {
      return sendJson(res, 200, { authenticated: await isAuthed(req) })
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req)
      if (tooManyAttempts(ip)) {
        return sendJson(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' })
      }
      const body = await readBody(req)
      const cfg = await loadConfig()
      const ok = hashPassword(body.password || '', cfg.salt) === cfg.passwordHash
      if (!ok) {
        noteAttempt(ip)
        return sendJson(res, 401, { error: 'La contraseña no es correcta' })
      }
      attempts.delete(ip)
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `ccm_session=${makeToken(cfg.secret)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`,
      })
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': 'ccm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      })
    }

    if (pathname === '/api/content' && req.method === 'PUT') {
      if (!(await isAuthed(req))) return sendJson(res, 401, { error: 'Tienes que iniciar sesión otra vez' })
      const incoming = await readBody(req)
      const merged = mergeContent(await loadContent(), incoming)
      await saveContentWithBackup(merged)
      return sendJson(res, 200, { ok: true, content: merged })
    }

    if (pathname === '/api/upload' && req.method === 'POST') {
      if (!(await isAuthed(req))) return sendJson(res, 401, { error: 'Tienes que iniciar sesión otra vez' })
      const result = await handleUpload(await readBody(req))
      return sendJson(res, result.error ? 400 : 200, result)
    }

    // --- contingut i fotos ---
    if (pathname === '/content.json') {
      return serveFile(res, CONTENT_FILE)
    }

    if (pathname.indexOf('/uploads/') === 0) {
      const target = safeJoin(UPLOADS_DIR, pathname.slice('/uploads/'.length))
      return target ? serveFile(res, target, { cache: true }) : sendJson(res, 400, { error: 'Ruta no válida' })
    }

    // --- web estatica ---
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
    const target = safeJoin(PUBLIC_DIR, rel)
    if (target && existsSync(target) && statSync(target).isFile()) {
      return serveFile(res, target, { cache: rel !== 'index.html' })
    }
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'))
  } catch (err) {
    const isTooLarge = err && err.message === 'too large'
    const msg = isTooLarge ? 'El archivo es demasiado grande' : 'Error del servidor'
    return sendJson(res, isTooLarge ? 413 : 500, { error: msg })
  }
})

// ------------------------------------------------------------------- arrencada

async function setPasswordAndExit(nueva) {
  await ensureData()
  const cfg = await loadConfig()
  cfg.salt = crypto.randomBytes(16).toString('hex')
  cfg.passwordHash = hashPassword(nueva, cfg.salt)
  cfg.secret = crypto.randomBytes(32).toString('hex') // tanca sessions obertes
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  console.log('Contrasenya actualitzada.')
  process.exit(0)
}

// Al VPS (systemd + nginx) nomes escoltem a localhost. A cPanel/Passenger
// sol caldre escoltar a totes les interficies perque el propi Passenger
// hi faci de pont; per aixo es pot forçar amb CCM_HOST.
const HOST = process.env.CCM_HOST || '127.0.0.1'

async function start() {
  await ensureData()
  await ensureStructureUpToDate()
  server.listen(PORT, HOST, () => {
    console.log(`CC Mallorca escoltant a http://${HOST}:${PORT} (dades: ${DATA_DIR})`)
  })
}

const setPwdIdx = process.argv.indexOf('--set-password')
if (setPwdIdx !== -1) {
  const nueva = process.argv[setPwdIdx + 1]
  if (!nueva) {
    console.error('Us: node server.js --set-password NOVA_CONTRASENYA')
    process.exit(1)
  }
  setPasswordAndExit(nueva).catch((err) => {
    console.error(err)
    process.exit(1)
  })
} else {
  start().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
