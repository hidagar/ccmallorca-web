// Analitza la copia de la web original i n'extreu el disseny exacte:
// colors, tipografies, amplades, fons i estructura.
//
// Us:  node analizar-diseno.mjs            (informe per pantalla)
//      node analizar-diseno.mjs --json     (informe a diseno-original.json)
//
// La sortida es prou curta per enganxar-la en una conversa: serveix per
// reproduir el format i els colors sense haver de veure la web.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, 'original')
const AS_JSON = process.argv.includes('--json')

// Noms de color HTML mes habituals als anys 90, per traduir-los a hex
const NAMED = {
  white: '#FFFFFF', black: '#000000', red: '#FF0000', lime: '#00FF00',
  blue: '#0000FF', yellow: '#FFFF00', cyan: '#00FFFF', aqua: '#00FFFF',
  magenta: '#FF00FF', fuchsia: '#FF00FF', silver: '#C0C0C0', gray: '#808080',
  grey: '#808080', maroon: '#800000', olive: '#808000', green: '#008000',
  purple: '#800080', teal: '#008080', navy: '#000080', orange: '#FFA500',
  gold: '#FFD700', beige: '#F5F5DC', ivory: '#FFFFF0', tan: '#D2B48C',
  brown: '#A52A2A', darkblue: '#00008B', lightblue: '#ADD8E6',
  darkgreen: '#006400', lightgrey: '#D3D3D3', lightgray: '#D3D3D3',
}

function normColor(raw) {
  if (!raw) return null
  let c = String(raw).trim().toLowerCase().replace(/["';]/g, '')
  if (NAMED[c]) return NAMED[c]
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c)
  if (rgb) {
    return '#' + [rgb[1], rgb[2], rgb[3]]
      .map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  c = c.replace(/^#/, '')
  if (/^[0-9a-f]{3}$/.test(c)) c = c.split('').map((x) => x + x).join('')
  if (/^[0-9a-f]{6}$/.test(c)) return '#' + c.toUpperCase()
  return null
}

function bump(map, key, n = 1) {
  if (!key) return
  map.set(key, (map.get(key) || 0) + n)
}

function top(map, limit = 12) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}

function attrOf(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : ''
}

async function walk(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    else out.push(full)
  }
  return out
}

function decode(buf) {
  const head = buf.slice(0, 3000).toString('latin1')
  const m = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)
  const cs = (m ? m[1] : 'utf-8').toLowerCase()
  return /^(windows-1252|iso-8859-1|iso-8859-15|latin1)$/.test(cs)
    ? buf.toString('latin1')
    : buf.toString('utf8')
}

const report = {
  paginas: [],
  colores: { fondo: new Map(), texto: new Map(), enlaces: new Map(), enlacesVisitados: new Map(), celdas: new Map(), fuentes: new Map(), css: new Map() },
  tipografias: new Map(),
  tamanosFuente: new Map(),
  anchuras: new Map(),
  imagenesFondo: new Map(),
  alineaciones: new Map(),
  usaFrames: false,
  usaTablasMaquetacion: 0,
  hojasCss: [],
  totalPaginas: 0,
}

const files = await walk(DIR)
if (!existsSync(DIR) || !files.length) {
  console.error('ERROR: no hi ha la copia de la web a', DIR)
  console.error('Executa primer:  bash clients/ccmallorca/mirror-original.sh --fotos')
  process.exit(1)
}

const htmlFiles = files.filter((f) => /\.html?$/i.test(f))
const cssFiles = files.filter((f) => /\.css$/i.test(f))

for (const file of htmlFiles) {
  const html = decode(await readFile(file))
  const rel = path.relative(DIR, file)
  report.totalPaginas++

  if (/<frameset/i.test(html)) report.usaFrames = true

  // <body ...>
  const body = /<body[^>]*>/i.exec(html)
  if (body) {
    const b = body[0]
    bump(report.colores.fondo, normColor(attrOf(b, 'bgcolor')))
    bump(report.colores.texto, normColor(attrOf(b, 'text')))
    bump(report.colores.enlaces, normColor(attrOf(b, 'link')))
    bump(report.colores.enlacesVisitados, normColor(attrOf(b, 'vlink')))
    const bg = attrOf(b, 'background')
    if (bg) bump(report.imagenesFondo, bg)
  }

  // <font color face size>
  for (const m of html.matchAll(/<font[^>]*>/gi)) {
    bump(report.colores.fuentes, normColor(attrOf(m[0], 'color')))
    const face = attrOf(m[0], 'face')
    if (face) bump(report.tipografias, face.split(',')[0].trim())
    const size = attrOf(m[0], 'size')
    if (size) bump(report.tamanosFuente, size)
  }

  // taules de maquetacio
  for (const m of html.matchAll(/<table[^>]*>/gi)) {
    report.usaTablasMaquetacion++
    const w = attrOf(m[0], 'width')
    if (w) bump(report.anchuras, w)
    bump(report.colores.celdas, normColor(attrOf(m[0], 'bgcolor')))
  }
  for (const m of html.matchAll(/<td[^>]*>/gi)) {
    bump(report.colores.celdas, normColor(attrOf(m[0], 'bgcolor')))
  }
  for (const m of html.matchAll(/align\s*=\s*["']?(left|center|right|justify)/gi)) {
    bump(report.alineaciones, m[1].toLowerCase())
  }

  // estils en linia i <style>
  for (const m of html.matchAll(/(?:background(?:-color)?|color)\s*:\s*([^;"'}\)]+)/gi)) {
    bump(report.colores.css, normColor(m[1]))
  }
  for (const m of html.matchAll(/font-family\s*:\s*([^;"'}]+)/gi)) {
    bump(report.tipografias, m[1].split(',')[0].replace(/["']/g, '').trim())
  }

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  report.paginas.push({
    archivo: rel,
    titulo: title ? title[1].replace(/\s+/g, ' ').trim().slice(0, 70) : '',
    bytes: html.length,
  })
}

for (const file of cssFiles) {
  const css = decode(await readFile(file))
  report.hojasCss.push(path.relative(DIR, file))
  for (const m of css.matchAll(/(?:background(?:-color)?|color)\s*:\s*([^;}\)]+)/gi)) {
    bump(report.colores.css, normColor(m[1]))
  }
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    bump(report.tipografias, m[1].split(',')[0].replace(/["']/g, '').trim())
  }
}

// ------------------------------------------------------------------- sortida

if (AS_JSON) {
  const plain = (m) => Object.fromEntries(top(m, 30))
  const out = {
    totalPaginas: report.totalPaginas,
    usaFrames: report.usaFrames,
    tablasMaquetacion: report.usaTablasMaquetacion,
    hojasCss: report.hojasCss,
    colores: {
      fondo: plain(report.colores.fondo),
      texto: plain(report.colores.texto),
      enlaces: plain(report.colores.enlaces),
      enlacesVisitados: plain(report.colores.enlacesVisitados),
      celdas: plain(report.colores.celdas),
      fuentes: plain(report.colores.fuentes),
      css: plain(report.colores.css),
    },
    tipografias: plain(report.tipografias),
    tamanosFuente: plain(report.tamanosFuente),
    anchuras: plain(report.anchuras),
    imagenesFondo: plain(report.imagenesFondo),
    alineaciones: plain(report.alineaciones),
    paginas: report.paginas,
  }
  const dest = path.join(HERE, 'diseno-original.json')
  await writeFile(dest, JSON.stringify(out, null, 2))
  console.log('Informe escrit a', dest)
  process.exit(0)
}

const line = (label, entries, suffix = '') => {
  if (!entries.length) return
  console.log(`  ${label.padEnd(22)} ${entries.map(([k, n]) => `${k} (${n}${suffix})`).join('  ')}`)
}

console.log('\n============================================================')
console.log(' DISSENY DE LA WEB ORIGINAL')
console.log('============================================================')
console.log(`  Pagines analitzades   ${report.totalPaginas}`)
console.log(`  Fa servir frames      ${report.usaFrames ? 'SI' : 'no'}`)
console.log(`  Taules de maquetacio  ${report.usaTablasMaquetacion}`)
console.log(`  Fulles CSS            ${report.hojasCss.length ? report.hojasCss.join(', ') : 'cap (tot en atributs HTML)'}`)

console.log('\n-- COLORS ------------------------------------------------')
line('Fons de pagina', top(report.colores.fondo, 6))
line('Text', top(report.colores.texto, 6))
line('Enllaços', top(report.colores.enlaces, 6))
line('Enllaços visitats', top(report.colores.enlacesVisitados, 6))
line('Fons de cel·les', top(report.colores.celdas, 8))
line('Colors de <font>', top(report.colores.fuentes, 10))
line('Colors de CSS', top(report.colores.css, 10))

console.log('\n-- TIPOGRAFIA --------------------------------------------')
line('Tipus de lletra', top(report.tipografias, 8))
line('Mides de <font>', top(report.tamanosFuente, 8))

console.log('\n-- MAQUETACIO --------------------------------------------')
line('Amplades de taula', top(report.anchuras, 8))
line('Alineacions', top(report.alineaciones, 5))
line('Imatges de fons', top(report.imagenesFondo, 5))

console.log('\n-- PAGINES -----------------------------------------------')
for (const p of report.paginas.slice(0, 40)) {
  console.log(`  ${p.archivo.padEnd(30).slice(0, 30)} ${String(p.bytes).padStart(7)} b  ${p.titulo}`)
}
if (report.paginas.length > 40) console.log(`  ... i ${report.paginas.length - 40} mes`)

console.log('\n============================================================')
console.log(' Enganxa aquest informe a la conversa per reproduir')
console.log(' el format i els colors exactes.')
console.log('============================================================\n')
