// Converteix la copia de la web original (HTML de FrontPage) en el
// content.json que fa servir la web nova, i copia les fotos.
//
// Us:
//   node import-original.mjs [--dry]
//
// Llegeix   clients/ccmallorca/original/
// Escriu    $CCM_DATA_DIR/content.json  i  $CCM_DATA_DIR/uploads/
//
// Els textos i les fotos surten de la web real; l'estructura es genera un
// sol cop aqui. Despres el client nomes edita valors, no l'estructura.

import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ORIGINAL_DIR = path.join(HERE, 'original')
const DATA_DIR = process.env.CCM_DATA_DIR || '/var/www/ccmallorca-data'
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
const DRY = process.argv.includes('--dry')

// Pagines que no son contingut real
const SKIP = /^(mapa|sitemap|index_?frame|frame|menu|banner|barra|nav|left|top|bottom|contador|buscar|search|404)/i

// ------------------------------------------------------------------ utilitats

function decodeHtml(buffer) {
  const head = buffer.slice(0, 3000).toString('latin1')
  const m = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)
  const charset = (m ? m[1] : 'utf-8').toLowerCase()
  if (/^(windows-1252|iso-8859-1|iso-8859-15|latin1|ansi_x3\.4-1968)$/.test(charset)) {
    // FrontPage guarda gairebe sempre en Windows-1252
    return buffer.toString('latin1')
  }
  return buffer.toString('utf8')
}

const ENTITIES = {
  nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', ccedil: 'ç', Ccedil: 'Ç',
  agrave: 'à', egrave: 'è', ograve: 'ò', Agrave: 'À', Egrave: 'È', Ograve: 'Ò',
  iquest: '¿', iexcl: '¡', laquo: '«', raquo: '»', deg: '°', middot: '·',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  euro: '€', copy: '©', reg: '®', trade: '™', bull: '•',
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m
    )
}

function safeChar(code) {
  try {
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

function clean(text) {
  return decodeEntities(text)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

// Com clean() pero traient qualsevol etiqueta (<font>, <b>...) que FrontPage
// deixa dins dels titols.
function cleanText(text) {
  return clean(String(text).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

// Etiquetes de navegacio habituals: si un bloc curt nomes te aixo, no es contingut.
const NAV_WORDS = /^(inicio|home|portada|index|principal|articulos|art[\u00edi]culos|reportajes|informes|opini[\u00f3o]n|opinion|galer[\u00edi]a|galeria|fotos|imagenes|enlaces|links|contacto|contacte|mapa|mapa del web|mapa_del_web|anterior|siguiente|volver|atr[\u00e1a]s|arriba|men[\u00fau]|email|e-mail|correo|buscar|novedades|libro de visitas|firmar)$/i

function isNavigationBlock(text) {
  if (!text || text.length > 90) return false
  const parts = text.split(/\s*[|\u00b7\u2022>\/]\s*|\n/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return false
  const navish = parts.filter((p) => NAV_WORDS.test(p.replace(/\.html?$/i, ''))).length
  return navish >= Math.max(1, Math.ceil(parts.length * 0.6))
}

function isCopyrightBlock(text) {
  return /^(\u00a9|\(c\)|copyright)/i.test(text)
    || /(todos los derechos|tots els drets|dise[\u00f1n]ada? por|webmaster|actualizad[ao] el)/i.test(text)
    || (/\u00a9/.test(text) && text.length < 120)
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function slugify(s) {
  return decodeEntities(String(s))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pagina'
}

// ------------------------------------------------------ extraccio del contingut

// Trosseja el <body> en blocs de text i imatges, en l'ordre del document.
function extractBlocks(html, slug) {
  let body = html
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (bodyMatch) body = bodyMatch[1]

  // Fora tot el que no es contingut
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|select|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/<marquee[^>]*>([\s\S]*?)<\/marquee>/gi, '$1')

  const blocks = []
  let textBuffer = []
  let counter = 0

  function flushText() {
    // Nomes els \n explicits (afegits als límits de bloc reals: <br>, </p>,
    // </td>...) separen paràgrafs. Els diferents <font>/<i>/<span> que
    // trenquen una mateixa frase en trossos de text NO han d'afegir salts.
    const joined = textBuffer.join('')
    textBuffer = []
    const paragraphs = joined
      .split('\n')
      .map((p) => clean(p))
      // Fora els menus i els avisos de copyright del peu
      .filter((p) => p && p.length > 1 && !isNavigationBlock(p) && !isCopyrightBlock(p))
    if (!paragraphs.length) return
    const html = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')
    blocks.push({ id: `${slug}-texto-${++counter}`, type: 'text', html })
  }

  // Recorrem etiquetes rellevants en ordre
  const token = /<img\b[^>]*>|<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>|<\/(?:p|div|tr|td|li|table|h[1-4])>|<br\s*\/?>|<[^>]+>|[^<]+/gi
  let match

  while ((match = token.exec(body)) !== null) {
    const chunk = match[0]

    if (/^<img\b/i.test(chunk)) {
      const src = attr(chunk, 'src')
      const alt = clean(attr(chunk, 'alt') || '')
      if (src && !isDecorativeImage(src)) {
        flushText()
        blocks.push({
          id: `${slug}-foto-${++counter}`,
          type: 'image',
          src: '',
          _originalSrc: src,
          alt,
          caption: alt,
        })
      }
      continue
    }

    // Titols -> bloc heading
    const heading = /^<h[1-4]\b/i.test(chunk) ? cleanText(match[1] || '') : null
    if (heading !== null) {
      if (heading) {
        flushText()
        blocks.push({ id: `${slug}-titulo-${++counter}`, type: 'heading', text: heading })
      }
      continue
    }

    if (/^<(br|\/p|\/div|\/tr|\/td|\/li|\/table|\/h[1-4])/i.test(chunk)) {
      textBuffer.push('\n')
      continue
    }

    if (chunk.startsWith('<')) continue // qualsevol altra etiqueta: la ignorem

    // Els salts de linia del codi font no son salts de parragraf: nomes
    // separen paraules. Els parragrafs venen de </p>, <br> i companyia.
    textBuffer.push(chunk.replace(/\s*\n\s*/g, ' '))
  }

  flushText()
  return blocks
}

function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : ''
}

// Fotos de decoracio tipiques de FrontPage (fletxes, linies, vinyetes...)
function isDecorativeImage(src) {
  const f = src.toLowerCase()
  return /(spacer|pixel|blank|clear|bullet|vinyeta|arrow|fletxa|linea|line|hr|bar|boton|button|back|next|prev|home|mail|logo_?small|contador|counter|webbot)/.test(f)
    || /\.(gif)$/.test(f) && /(anim|ico|icon)/.test(f)
}

function pageTitle(html, fallback) {
  const h1 = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html)
  const heading = h1 ? cleanText(h1[1]) : ''

  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  let title = t ? cleanText(t[1]) : ''
  // Fora el nom del lloc i les extensions que FrontPage deixa al <title>
  title = title
    .replace(/\s*[-|·–—]\s*(cc[- ]?mallorca|ccmallorca)[^]*$/i, '')
    .replace(/^(cc[- ]?mallorca|ccmallorca)\s*[-|·–—]\s*/i, '')
    .replace(/\.html?\b/gi, '')
    .trim()

  // Un <title> que nomes es el nom del fitxer no serveix: millor el titol visible
  const looksLikeFilename = !title || title.length < 3 || /^[\w-]+$/.test(title)
  if (heading && (looksLikeFilename || title.length > 55)) return heading
  return title || heading || fallback
}

// Etiqueta curta per al menu
function menuLabel(title) {
  const short = title.split(/\s*[-·–—:]\s*/)[0].trim() || title
  if (short.length <= 24) return short
  const cut = short.slice(0, 24)
  const sp = cut.lastIndexOf(' ')
  return (sp > 10 ? cut.slice(0, sp) : cut) + '…'
}

// Compara dos titols ignorant accents, majuscules i signes
function sameish(a, b) {
  const norm = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '')
  return norm(a) === norm(b) && norm(a).length > 0
}

// ----------------------------------------------------------------- programa

async function findHtmlFiles(dir) {
  const out = []
  async function walk(d) {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else if (/\.html?$/i.test(e.name)) out.push(full)
    }
  }
  await walk(dir)
  return out
}

async function main() {
  if (!existsSync(ORIGINAL_DIR)) {
    console.error('ERROR: no hi ha la copia de la web original.')
    console.error('Executa primer:  bash clients/ccmallorca/mirror-original.sh --fotos')
    process.exit(1)
  }

  const files = await findHtmlFiles(ORIGINAL_DIR)
  if (!files.length) {
    console.error('ERROR: no s\'ha trobat cap fitxer .htm a', ORIGINAL_DIR)
    process.exit(1)
  }

  console.log(`Trobades ${files.length} pagines. Convertint...`)

  const pages = {}
  const menu = []
  const imagesToCopy = new Map()

  // La portada primer, la resta per ordre alfabetic
  files.sort((a, b) => {
    const ai = /index/i.test(path.basename(a)) ? 0 : 1
    const bi = /index/i.test(path.basename(b)) ? 0 : 1
    return ai - bi || a.localeCompare(b)
  })

  for (const file of files) {
    const base = path.basename(file)
    const raw = await readFile(file)
    const html = decodeHtml(raw)

    const isHome = /index/i.test(base)
    const slug = isHome ? 'inicio' : slugify(base)

    if (pages[slug]) continue

    const title = pageTitle(html, isHome ? 'Inicio' : slug.replace(/-/g, ' '))
    const blocks = extractBlocks(html, slug)

    // Si el primer titol repeteix el titol de la pagina, sobra
    while (blocks.length && blocks[0].type === 'heading' && sameish(blocks[0].text, title)) {
      blocks.shift()
    }

    // Nomes ometem el fitxer si SEMBLA navegacio PEL NOM i A MES no te
    // contingut real. Un fitxer com "mapa_del_web.htm" pot amagar un article
    // de veritat (el propietari hi ha publicat trobades), i no el volem
    // descartar nomes pel nom.
    const words = blocks
      .filter((b) => b.type === 'text')
      .reduce((n, b) => n + b.html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length, 0)
    const looksLikeNav = !isHome && SKIP.test(base)
    const almostEmpty = words < 12 && !blocks.some((b) => b.type === 'image')

    if (looksLikeNav && almostEmpty) {
      console.log(`  (omesa, sembla navegacio i esta buida) ${base}`)
      continue
    }
    if (!isHome && almostEmpty) {
      console.log(`  (omesa, gairebe buida) ${base}`)
      continue
    }
    if (looksLikeNav) {
      console.log(`  (avis: "${base}" sembla un nom de navegacio pero te ${words} paraules de contingut real; s'importa igualment)`)
    }

    // Resolem les fotos: les copiarem a uploads/
    for (const block of blocks) {
      if (block.type !== 'image') continue
      const resolved = path.resolve(path.dirname(file), block._originalSrc.split('?')[0])
      if (resolved.startsWith(path.resolve(ORIGINAL_DIR)) && existsSync(resolved)) {
        const ext = path.extname(resolved).toLowerCase() || '.jpg'
        const name = `${slugify(path.basename(resolved, path.extname(resolved)))}-${imagesToCopy.size}${ext}`
        imagesToCopy.set(resolved, name)
        block.src = `uploads/${name}`
      } else {
        block.src = '' // la foto no s'ha baixat: quedara buida per posar-la a ma
      }
      delete block._originalSrc
    }

    pages[slug] = {
      title,
      intro: '',
      blocks: blocks.length
        ? blocks
        : [{ id: `${slug}-texto-1`, type: 'text', html: '<p></p>' }],
    }

    menu.push({ slug, label: menuLabel(title) })
    console.log(`  ${base} -> ${slug} (${blocks.length} bloques, ${words} palabras)`)
  }

  if (!Object.keys(pages).length) {
    console.error('ERROR: no s\'ha pogut extreure contingut de cap pagina.')
    process.exit(1)
  }

  // Una galeria al final, amb les fotos que no han quedat dins de cap pagina
  const content = {
    site: {
      title: 'CC Mallorca',
      subtitle: 'Cuevas y simas del archipiélago Balear',
      footer: 'CC Mallorca · Espeleología en las Islas Baleares',
      email: '',
      telefon: '',
      adreca: 'Mallorca, Illes Balears',
    },
    menu,
    pages,
  }

  console.log(`\nResum: ${menu.length} seccions, ${imagesToCopy.size} fotos.`)

  if (DRY) {
    const out = path.join(HERE, 'content.imported.json')
    await writeFile(out, JSON.stringify(content, null, 2))
    console.log('Prova (--dry): escrit a', out, '\nNo s\'ha tocat el servidor.')
    return
  }

  await mkdir(UPLOADS_DIR, { recursive: true })

  let copied = 0
  for (const [from, name] of imagesToCopy) {
    try {
      const st = await stat(from)
      if (st.size > 0 && st.size < 12 * 1024 * 1024) {
        await copyFile(from, path.join(UPLOADS_DIR, name))
        copied++
      }
    } catch {}
  }
  console.log(`Fotos copiades a uploads/: ${copied}`)

  const contentFile = path.join(DATA_DIR, 'content.json')
  if (existsSync(contentFile)) {
    const backup = path.join(DATA_DIR, `content-abans-de-importar-${Date.now()}.json`)
    await copyFile(contentFile, backup)
    console.log('Copia de seguretat del contingut anterior:', backup)
  }
  await writeFile(contentFile, JSON.stringify(content, null, 2))
  console.log('Contingut real escrit a', contentFile)
}

main().catch((err) => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
