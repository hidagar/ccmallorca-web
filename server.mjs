// Servidor de la web de CC Mallorca con editor tipo FrontPage.
// Sense dependencies: nomes moduls natius de Node.
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

import http from 'node:http'
import { readFile, writeFile, mkdir, copyFile, readdir, unlink } from 'node:fs/promises'
import { existsSync, createReadStream, statSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
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

function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
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
      let url = (m ? (m[2] ?? m[3] ?? m[4] ?? '') : '').trim()
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
    console.log('Canvia-la amb: node server.mjs --set-password NOVA')
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
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

function makeToken(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return false
  const [payload, sig] = token.split('.')
  const expected = sign(payload, secret)
  if (sig.length !== expected.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now()
  } catch {
    return false
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

async function isAuthed(req) {
  const cfg = await loadConfig()
  return verifyToken(readCookie(req, 'ccm_session'), cfg.secret)
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
  for (const [slug, page] of Object.entries(pages)) {
    const target = out.pages[slug]
    if (!target || !page) continue

    if (typeof page.title === 'string') target.title = stripTags(page.title).slice(0, 200)
    if (typeof page.intro === 'string') target.intro = sanitizeHtml(page.intro)

    for (const block of Array.isArray(page.blocks) ? page.blocks : []) {
      const dest = target.blocks.find((b) => b.id === block?.id)
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
  } catch {}
  await writeFile(CONTENT_FILE, JSON.stringify(content, null, 2))
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
  } catch {
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

function serveFile(res, filePath, { cache = false } = {}) {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) throw new Error('not a file')
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache',
    })
    createReadStream(filePath).pipe(res)
  } catch {
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
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

// ------------------------------------------------------------------ servidor

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)

  try {
    // --- API ---
    if (pathname === '/api/session') {
      return sendJson(res, 200, { authenticated: await isAuthed(req) })
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown'
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

    if (pathname.startsWith('/uploads/')) {
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
    const msg = err?.message === 'too large' ? 'El archivo es demasiado grande' : 'Error del servidor'
    return sendJson(res, err?.message === 'too large' ? 413 : 500, { error: msg })
  }
})

// ------------------------------------------------------------------- arrencada

const setPwdIdx = process.argv.indexOf('--set-password')
if (setPwdIdx !== -1) {
  const nueva = process.argv[setPwdIdx + 1]
  if (!nueva) {
    console.error('Us: node server.mjs --set-password NOVA_CONTRASENYA')
    process.exit(1)
  }
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

await ensureData()
server.listen(PORT, HOST, () => {
  console.log(`CC Mallorca escoltant a http://${HOST}:${PORT} (dades: ${DATA_DIR})`)
})
