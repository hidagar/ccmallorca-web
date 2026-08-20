// Afegeix el bloc de /ccmallorca/ a la configuracio d'nginx, sense tocar
// res mes. Es pot executar diverses vegades: si ja hi es, no fa res.
//
// Us:  sudo node patch-nginx.mjs [/ruta/al/fitxer]
// Codis de sortida: 0 = fet o ja hi era, 1 = error

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const PORT = 5002
const CANDIDATES = [
  '/etc/nginx/sites-available/quadern-estiu',
  '/etc/nginx/sites-available/default',
  '/etc/nginx/conf.d/quadern-estiu.conf',
]

const BLOCK = `
    # Web de CC Mallorca (editor tipus FrontPage)
    location = /ccmallorca { return 301 /ccmallorca/; }

    location /ccmallorca/ {
        proxy_pass http://127.0.0.1:${PORT}/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 12M;
        proxy_read_timeout 60s;
    }
`

function findConfig() {
  const given = process.argv[2]
  if (given) {
    if (!existsSync(given)) fail(`No existeix el fitxer: ${given}`)
    return given
  }
  for (const c of CANDIDATES) {
    if (existsSync(c)) return c
  }
  // Ultim recurs: qualsevol fitxer que serveixi el quadern
  const dir = '/etc/nginx/sites-available'
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const full = path.join(dir, f)
      try {
        if (readFileSync(full, 'utf8').includes('/var/www/quadern-estiu')) return full
      } catch {}
    }
  }
  fail('No s\'ha trobat la configuracio d\'nginx. Passa-la com a argument.')
}

function fail(msg) {
  console.error('ERROR: ' + msg)
  process.exit(1)
}

// Troba el final del primer bloc "server { ... }" comptant claus
function serverBlockEnd(text) {
  const start = text.search(/server\s*\{/)
  if (start === -1) return -1
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const file = findConfig()
const original = readFileSync(file, 'utf8')

if (/location\s*\/?\s*=?\s*\/ccmallorca/.test(original)) {
  console.log(`Ja estava configurat a ${file}. No cal fer res.`)
  process.exit(0)
}

const end = serverBlockEnd(original)
if (end === -1) fail(`No s'ha trobat cap bloc "server { }" a ${file}`)

const backup = `${file}.abans-de-ccmallorca.${Date.now()}`
copyFileSync(file, backup)

const patched = original.slice(0, end) + BLOCK + original.slice(end)
writeFileSync(file, patched)

console.log(`Afegit el bloc /ccmallorca/ a ${file}`)
console.log(`Copia de seguretat: ${backup}`)
console.log(backup) // l'ultima linia la fa servir l'script per desfer-ho si cal
