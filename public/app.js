/* CC Mallorca — render de la web i editor "al damunt de la pagina" (estil FrontPage).
   Sense frameworks: JS pla, sense compilacio. */

(function () {
  'use strict'

  var state = {
    content: null,
    slug: 'inicio',
    editing: false,
    admin: false,
    dirty: false,
    saving: false,
  }

  function uid(prefix) {
    return (prefix || 'bloc') + '-' + Math.random().toString(36).slice(2, 8)
  }

  function slugifyClient(s) {
    return String(s || '')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  }

  function newBlock(type) {
    var id = uid(type)
    if (type === 'heading') return { id: id, type: 'heading', text: 'Nuevo título' }
    if (type === 'text') return { id: id, type: 'text', html: '<p>Escribe aquí el texto…</p>' }
    if (type === 'image') return { id: id, type: 'image', src: '', alt: '', caption: '', credit: '' }
    if (type === 'gallery') return { id: id, type: 'gallery', images: [] }
    if (type === 'document') return { id: id, type: 'document', src: '', label: '' }
    return null
  }

  var BLOCK_KIND = {
    heading: 'Título', text: 'Texto', image: 'Foto',
    gallery: 'Galería de fotos', document: 'Documento PDF',
  }

  var main = document.getElementById('contenido')
  var navList = document.getElementById('navList')
  var navEl = document.getElementById('mainNav')

  // ------------------------------------------------------------- utilitats

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k]
        else if (k === 'html') node.innerHTML = attrs[k]
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2), attrs[k])
        } else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) {
          node.setAttribute(k, attrs[k])
        }
      })
    }
    ;(children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return node
  }

  function toast(message, kind) {
    var old = document.querySelector('.toast')
    if (old) old.remove()
    var t = el('div', { class: 'toast ' + (kind || ''), role: 'status', text: message })
    document.body.appendChild(t)
    setTimeout(function () { if (t.parentNode) t.remove() }, kind === 'err' ? 5000 : 2800)
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Error de conexión')
        return data
      })
    })
  }

  // Puja un fitxer (dataURL) com a multipart/form-data: ocupa menys que
  // el base64 dins d'un JSON i PHP el rep directament a $_FILES.
  function uploadFile(name, dataUrl, kind) {
    var parts = dataUrl.split(',')
    var mime = (/^data:([^;]+)/.exec(parts[0]) || [])[1] || 'application/octet-stream'
    var bin = atob(parts[1] || '')
    var bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    var form = new FormData()
    form.append('file', new Blob([bytes], { type: mime }), name)
    form.append('name', name)
    form.append('kind', kind)
    return fetch('api.php?r=upload', { method: 'POST', body: form, credentials: 'same-origin' })
      .then(function (res) {
        return res.json().catch(function () { return {} }).then(function (data) {
          if (!res.ok) {
            throw new Error(data.error || (res.status === 413 ? 'El archivo es demasiado grande' : 'Error de conexión'))
          }
          return data
        })
      })
  }

  function markDirty() {
    state.dirty = true
    updateEditbar()
  }

  // ------------------------------------------------------------- routing

  function currentSlug() {
    var raw = (location.hash || '').replace(/^#\/?/, '').trim()
    if (!raw || raw === 'edit') return 'inicio'
    return state.content && state.content.pages[raw] ? raw : 'inicio'
  }

  function go(slug) {
    location.hash = '#/' + slug
  }

  window.addEventListener('hashchange', function () {
    state.slug = currentSlug()
    render()
    window.scrollTo({ top: 0, behavior: 'smooth' })
    if (navEl) navEl.classList.remove('open')
  })

  // ------------------------------------------------------------- render

  function renderNav() {
    navList.innerHTML = ''
    ;(state.content.menu || []).forEach(function (item) {
      navList.appendChild(el('li', null, [
        el('a', {
          href: '#/' + item.slug,
          'aria-current': item.slug === state.slug ? 'page' : null,
          text: item.label,
        }),
      ]))
    })
  }

  function bindEditableText(node, apply, plainOnly) {
    node.setAttribute('data-editable', '1')
    node.setAttribute('contenteditable', plainOnly ? 'plaintext-only' : 'true')
    node.setAttribute('spellcheck', 'true')
    node.addEventListener('input', function () {
      apply(plainOnly ? node.textContent : node.innerHTML)
      markDirty()
    })
    // Si el navegador no suporta plaintext-only, evitem enganxar format
    node.addEventListener('paste', function (e) {
      if (!plainOnly) return
      e.preventDefault()
      var text = (e.clipboardData || window.clipboardData).getData('text')
      document.execCommand('insertText', false, text)
    })
    if (!plainOnly) node.addEventListener('keyup', positionFormatBar)
    if (!plainOnly) node.addEventListener('mouseup', positionFormatBar)
  }

  function pickFiles(accept, multiple) {
    return new Promise(function (resolve) {
      var input = el('input', { type: 'file', accept: accept, multiple: multiple ? 'multiple' : null })
      input.style.display = 'none'
      document.body.appendChild(input)
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || [])
        input.remove()
        Promise.all(files.map(function (file) {
          return new Promise(function (res) {
            var reader = new FileReader()
            reader.onload = function () { res({ name: file.name, data: String(reader.result) }) }
            reader.onerror = function () { res(null) }
            reader.readAsDataURL(file)
          })
        })).then(function (list) { resolve(list.filter(Boolean)) })
      })
      input.click()
    })
  }

  // Redueix la foto al navegador abans de pujar-la. El client puja fotos
  // de camera enormes (4000px, 8+ MB): sense aixo li donarien error de
  // mida o farien la web lentissima. Maxim 1600px pel costat gran,
  // JPEG al 85%. Els GIF no es toquen (poden ser animats) i si per
  // qualsevol motiu falla, es puja l'original tal qual. De passada en
  // guardem la proporcio (ample/alt) per muntar els mosaics.
  var MAX_SIDE = 1600
  var SMALL_ENOUGH = 700 * 1024 // ~500 KB reals en base64

  function prepareImage(picked) {
    return new Promise(function (resolve) {
      if (!picked) return resolve(null)
      var probe = new Image()
      probe.onload = function () {
        var w = probe.naturalWidth
        var h = probe.naturalHeight
        picked.ratio = w && h ? Math.round((w / h) * 1000) / 1000 : undefined
        if (picked.data.indexOf('data:image/gif') === 0 ||
            ((w <= MAX_SIDE && h <= MAX_SIDE) && picked.data.length <= SMALL_ENOUGH)) {
          return resolve(picked)
        }
        try {
          var scale = Math.min(1, MAX_SIDE / Math.max(w, h))
          var canvas = document.createElement('canvas')
          canvas.width = Math.round(w * scale)
          canvas.height = Math.round(h * scale)
          canvas.getContext('2d').drawImage(probe, 0, 0, canvas.width, canvas.height)
          var out = canvas.toDataURL('image/jpeg', 0.85)
          if (out.indexOf('data:image/jpeg') !== 0 || out.length >= picked.data.length) {
            return resolve(picked)
          }
          resolve({
            name: picked.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg',
            data: out,
            ratio: picked.ratio,
          })
        } catch (e) {
          resolve(picked)
        }
      }
      probe.onerror = function () { resolve(picked) }
      probe.src = picked.data
    })
  }

  // Puja una o diverses fotos, una darrere l'altra. Retorna [{src, ratio}].
  function uploadImages(multiple) {
    return pickFiles('image/jpeg,image/png,image/gif,image/webp', multiple).then(function (list) {
      var done = []
      var chain = Promise.resolve()
      list.forEach(function (picked, i) {
        chain = chain.then(function () {
          toast(list.length > 1
            ? 'Subiendo foto ' + (i + 1) + ' de ' + list.length + '…'
            : 'Subiendo la foto…')
          return prepareImage(picked).then(function (ready) {
            return uploadFile(ready.name, ready.data, 'image')
              .then(function (res) { done.push({ src: res.src, ratio: ready.ratio }) })
          }).catch(function (err) {
            toast(picked.name + ': ' + err.message, 'err')
          })
        })
      })
      return chain.then(function () {
        if (done.length) toast(done.length > 1 ? done.length + ' fotos subidas' : 'Foto subida', 'ok')
        return done
      })
    })
  }

  function uploadImage() {
    return uploadImages(false).then(function (list) { return list[0] || null })
  }

  function uploadDocument() {
    return pickFiles('application/pdf', false).then(function (list) {
      var picked = list[0]
      if (!picked) return null
      toast('Subiendo el documento…')
      return uploadFile(picked.name, picked.data, 'document').then(function (res) {
        toast('Documento subido', 'ok')
        return { src: res.src, name: picked.name }
      }).catch(function (err) {
        toast(err.message, 'err')
        return null
      })
    })
  }

  function photoActions(buttons) {
    return el('div', { class: 'photo-actions' }, buttons.map(function (b) {
      return el('button', {
        type: 'button',
        class: 'photo-btn' + (b.danger ? ' danger' : ''),
        onclick: b.onClick,
        text: b.label,
        title: b.title || null,
      })
    }))
  }

  // ----------------------------------------------------- ampliar fotos (lightbox)
  // Totes les fotos de la pagina formen una sequencia: amb les fletxes (o
  // lliscant el dit al mobil) es passa a l'anterior / seguent.

  var pagePhotos = []

  // Totes les fotos de la pagina, en ordre, per al visor
  function collectPhotos(page) {
    var list = []
    ;(page.blocks || []).forEach(function (b) {
      if (b.type === 'image' && b.src) list.push(b)
      if (b.type === 'gallery') (b.images || []).forEach(function (im) { if (im.src) list.push(im) })
    })
    return list
  }

  function openLightbox(index) {
    if (!pagePhotos.length) return
    var current = index
    var overlay = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Foto ampliada' })
    var img = el('img', { alt: '' })
    var caption = el('p', { class: 'lightbox-caption' })
    var count = el('p', { class: 'lightbox-count' })
    var content = el('div', { class: 'lightbox-content' }, [img, caption, count])

    function show(i) {
      current = (i + pagePhotos.length) % pagePhotos.length
      var photo = pagePhotos[current]
      img.src = photo.src
      img.alt = photo.alt || photo.caption || ''
      var text = photo.caption || ''
      if (photo.credit) text += (text ? ' — ' : '') + creditText(photo.credit)
      caption.textContent = text
      caption.style.display = text ? '' : 'none'
      count.textContent = pagePhotos.length > 1 ? (current + 1) + ' / ' + pagePhotos.length : ''
    }

    function close() {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
    }
    function onKey(e) {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft') show(current - 1)
      else if (e.key === 'ArrowRight') show(current + 1)
    }

    overlay.appendChild(el('button', {
      type: 'button', class: 'lightbox-close', 'aria-label': 'Cerrar', text: '✕', onclick: close,
    }))
    if (pagePhotos.length > 1) {
      overlay.appendChild(el('button', {
        type: 'button', class: 'lightbox-nav prev', 'aria-label': 'Foto anterior', text: '‹',
        onclick: function () { show(current - 1) },
      }))
      overlay.appendChild(el('button', {
        type: 'button', class: 'lightbox-nav next', 'aria-label': 'Foto siguiente', text: '›',
        onclick: function () { show(current + 1) },
      }))
    }
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target === content) close()
    })
    var touchX = null
    overlay.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX }, { passive: true })
    overlay.addEventListener('touchend', function (e) {
      if (touchX === null) return
      var dx = e.changedTouches[0].clientX - touchX
      touchX = null
      if (Math.abs(dx) > 50) show(current + (dx < 0 ? 1 : -1))
    })
    document.addEventListener('keydown', onKey)

    overlay.appendChild(content)
    document.body.appendChild(overlay)
    show(current)
  }

  function creditText(credit) {
    return /^fotos?\b/i.test(credit) ? credit : 'Foto: ' + credit
  }

  // Proporcio de la foto. Si encara no la sabem (fotos importades o
  // antigues), la calculem quan carrega i ho notifiquem per repintar.
  var DEFAULT_RATIO = 4 / 3

  function ratioOf(obj) {
    return obj.ratio > 0 ? obj.ratio : DEFAULT_RATIO
  }

  // Una foto amb vora fina i el credit a la cantonada (estil original).
  // Fora del mode edicio, en clicar-la s'amplia.
  function photoTile(obj, onRatio) {
    var img = el('img', { src: obj.src, alt: obj.alt || obj.caption || '', loading: 'lazy', decoding: 'async' })
    if (!(obj.ratio > 0)) {
      img.addEventListener('load', function () {
        if (!img.naturalWidth || !img.naturalHeight) return
        obj.ratio = Math.round((img.naturalWidth / img.naturalHeight) * 1000) / 1000
        if (onRatio) onRatio()
      })
    }
    var tile = el('div', { class: 'tile' }, [img])
    if (obj.credit) tile.appendChild(el('span', { class: 'photo-credit', text: creditText(obj.credit) }))
    if (!state.editing) {
      img.classList.add('zoomable')
      img.setAttribute('title', 'Clic para ampliar')
      img.addEventListener('click', function () {
        openLightbox(Math.max(0, pagePhotos.indexOf(obj)))
      })
    }
    return tile
  }

  function renderImageBlock(block) {
    var figure = el('figure', { class: 'photo-wrap photo-single' })

    function paint() {
      figure.innerHTML = ''
      if (block.src) {
        figure.appendChild(photoTile(block))
      } else {
        figure.appendChild(el('div', {
          class: 'photo-empty',
          text: state.editing ? 'Sin foto todavía. Pulsa «Poner foto».' : '',
        }))
      }

      var caption = el('figcaption', { text: block.caption || '' })
      if (state.editing || block.caption) figure.appendChild(caption)
      if (!state.editing) return

      bindEditableText(caption, function (v) { block.caption = v }, true)
      caption.setAttribute('aria-label', 'Texto debajo de la foto')

      var creditInput = el('input', {
        type: 'text', class: 'credit-input',
        placeholder: 'Autor de la foto (ej: L. Ramírez)',
        value: block.credit || '',
      })
      creditInput.addEventListener('input', function () {
        block.credit = creditInput.value
        markDirty()
        var span = figure.querySelector('.photo-credit')
        if (span && block.credit) span.textContent = creditText(block.credit)
        else if (block.src) paintKeepFocus()
      })
      figure.appendChild(creditInput)

      figure.appendChild(photoActions([
        {
          label: block.src ? 'Cambiar foto' : 'Poner foto',
          onClick: function () {
            uploadImage().then(function (up) {
              if (!up) return
              block.src = up.src
              block.ratio = up.ratio
              markDirty()
              paint()
            })
          },
        },
        block.src ? {
          label: 'Quitar foto',
          danger: true,
          onClick: function () {
            block.src = ''
            delete block.ratio
            markDirty()
            paint()
          },
        } : null,
      ].filter(Boolean)))
    }

    // Repinta mantenint el focus a la casella d'autor
    function paintKeepFocus() {
      paint()
      var input = figure.querySelector('.credit-input')
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
    }

    paint()
    return figure
  }

  // Reparteix n fotos en files de 2-3, com feia l'original.
  function chunkRows(items) {
    var n = items.length
    var sizes = []
    if (n <= 3) sizes = [n]
    else if (n === 4) sizes = [2, 2]
    else {
      var left = n
      while (left > 0) {
        if (left === 4) { sizes.push(2, 2); left = 0 }
        else if (left <= 3) { sizes.push(left); left = 0 }
        else { sizes.push(3); left -= 3 }
      }
    }
    var rows = []
    var at = 0
    sizes.forEach(function (s) { rows.push(items.slice(at, at + s)); at += s })
    return rows
  }

  // Fila justificada: cada foto creix segons la seva proporcio, i aixi
  // totes queden a la mateixa alçada sense retallar res.
  function mosaicRow(images, onRatio) {
    return el('div', { class: 'mrow' }, images.map(function (im) {
      var t = photoTile(im, onRatio)
      var r = ratioOf(im)
      t.style.flexGrow = r
      t.style.aspectRatio = r
      return t
    }))
  }

  // "Dues apilades + una alta" (com a la portada original). Les amplades
  // es calculen perque la columna apilada i la foto alta facin la mateixa
  // alçada: columna = 1/sum(1/r_i), alta = r.
  function mosaicStack(stack, tall, tallFirst, onRatio) {
    var invSum = 0
    var col = el('div', { class: 'mcol' }, stack.map(function (im) {
      var t = photoTile(im, onRatio)
      t.style.aspectRatio = ratioOf(im)
      invSum += 1 / ratioOf(im)
      return t
    }))
    col.style.flexGrow = 1 / invSum
    var tallWrap = el('div', { class: 'mtall' }, [photoTile(tall, onRatio)])
    tallWrap.style.flexGrow = ratioOf(tall)
    return el('div', { class: 'mrow' }, tallFirst ? [tallWrap, col] : [col, tallWrap])
  }

  function renderMosaic(block, onRatio) {
    var images = block.images || []
    var layout = block.layout || 'fila'
    var box = el('div', { class: 'mosaic' })
    var rest = images

    if ((layout === 'mosaico' || layout === 'mosaico-izquierda') && images.length >= 3) {
      if (layout === 'mosaico') box.appendChild(mosaicStack(images.slice(0, 2), images[2], false, onRatio))
      else box.appendChild(mosaicStack(images.slice(1, 3), images[0], true, onRatio))
      rest = images.slice(3)
    }
    chunkRows(rest).forEach(function (row) { box.appendChild(mosaicRow(row, onRatio)) })
    return box
  }

  function renderGrid(block) {
    return el('div', { class: 'gallery-grid' }, (block.images || []).map(function (im) {
      var fig = el('figure', null, [photoTile(im)])
      if (im.caption) fig.appendChild(el('figcaption', { text: im.caption }))
      return fig
    }))
  }

  function renderGalleryBlock(block) {
    var wrap = el('div', { class: 'gallery' })
    var preview = el('div')
    wrap.appendChild(preview)

    var pending = null
    function onRatio() {
      // Diverses fotos poden carregar alhora: un sol repintat
      if (pending) return
      pending = setTimeout(function () { pending = null; paintPreview() }, 30)
    }

    function paintPreview() {
      preview.innerHTML = ''
      var images = block.images || []
      if (!images.length) {
        if (state.editing) {
          preview.appendChild(el('div', { class: 'photo-empty', text: 'Galería vacía. Añade fotos con el botón de abajo.' }))
        }
        return
      }
      preview.appendChild(block.layout === 'rejilla' ? renderGrid(block) : renderMosaic(block, onRatio))
    }

    paintPreview()

    if (state.editing) {
      var list = el('div', { class: 'gal-edit' })
      wrap.appendChild(list)

      var paintList = function () {
        list.innerHTML = ''
        var images = block.images || (block.images = [])
        list.appendChild(el('p', {
          class: 'gal-edit-title',
          text: images.length ? 'Fotos de este grupo (' + images.length + '):' : 'Fotos de este grupo:',
        }))

        images.forEach(function (im, index) {
          function field(key, placeholder) {
            var input = el('input', { type: 'text', placeholder: placeholder, value: im[key] || '' })
            input.addEventListener('input', function () {
              im[key] = input.value
              markDirty()
              onRatio()
            })
            return input
          }
          function move(delta) {
            var j = index + delta
            if (j < 0 || j >= images.length) return
            images[index] = images[j]
            images[j] = im
            markDirty(); paintPreview(); paintList()
          }
          list.appendChild(el('div', { class: 'gal-item' }, [
            el('img', { class: 'gal-thumb', src: im.src, alt: '' }),
            el('div', { class: 'gal-fields' }, [
              field('credit', 'Autor de la foto (ej: L. Ramírez)'),
              field('caption', 'Descripción (se ve al ampliar la foto)'),
              el('div', { class: 'gal-btns' }, [
                el('button', { type: 'button', class: 'photo-btn', text: '← Antes', disabled: index === 0, onclick: function () { move(-1) } }),
                el('button', { type: 'button', class: 'photo-btn', text: 'Después →', disabled: index === images.length - 1, onclick: function () { move(1) } }),
                el('button', {
                  type: 'button', class: 'photo-btn', text: 'Cambiar foto',
                  onclick: function () {
                    uploadImage().then(function (up) {
                      if (!up) return
                      im.src = up.src
                      im.ratio = up.ratio
                      markDirty(); paintPreview(); paintList()
                    })
                  },
                }),
                el('button', {
                  type: 'button', class: 'photo-btn danger', text: 'Quitar',
                  onclick: function () {
                    if (!confirm('¿Quitar esta foto del grupo?')) return
                    images.splice(index, 1)
                    markDirty(); paintPreview(); paintList()
                  },
                }),
              ]),
            ]),
          ]))
        })

        list.appendChild(el('button', {
          type: 'button', class: 'gallery-add',
          text: '+ Añadir fotos (puedes elegir varias a la vez)',
          onclick: function () {
            uploadImages(true).then(function (ups) {
              if (!ups.length) return
              ups.forEach(function (up) {
                block.images.push({ src: up.src, ratio: up.ratio, alt: '', caption: '', credit: '' })
              })
              markDirty(); paintPreview(); paintList()
            })
          },
        }))
      }
      paintList()
    }

    return wrap
  }

  function renderDocumentBlock(block) {
    var wrap = el('div', { class: 'doc-wrap' })

    function paint() {
      wrap.innerHTML = ''

      if (block.src) {
        var name = block.label || block.src.split('/').pop()
        wrap.appendChild(el('a', {
          class: 'doc-link',
          href: block.src,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, [
          el('span', { class: 'doc-icon', 'aria-hidden': 'true', text: '📄' }),
          el('span', { class: 'doc-name', text: name }),
        ]))
      } else {
        // Nomes hi arribem en mode edicio: renderBlock ja amaga aquest
        // bloc als visitants quan encara no hi ha document.
        wrap.appendChild(el('div', {
          class: 'doc-empty',
          text: 'Sin documento todavía. Pulsa «Añadir documento PDF».',
        }))
      }

      if (state.editing) {
        var label = el('input', {
          type: 'text',
          class: 'doc-label-input',
          placeholder: 'Nombre del documento (por ejemplo: Anexos 2023)',
          value: block.label || '',
        })
        label.addEventListener('input', function () {
          block.label = label.value
          markDirty()
        })
        wrap.appendChild(label)

        wrap.appendChild(photoActions([
          {
            label: block.src ? 'Cambiar PDF' : 'Añadir documento PDF',
            onClick: function () {
              uploadDocument().then(function (result) {
                if (!result) return
                block.src = result.src
                if (!block.label) block.label = result.name.replace(/\.pdf$/i, '')
                markDirty()
                paint()
              })
            },
          },
          block.src ? {
            label: 'Quitar PDF',
            danger: true,
            onClick: function () {
              block.src = ''
              markDirty()
              paint()
            },
          } : null,
        ].filter(Boolean)))
      }
    }

    paint()
    return wrap
  }

  function renderBlock(block) {
    var cls = 'block' + (block.width === 'half' ? ' half' : '')

    if (block.type === 'heading') {
      var h = el('h2', { text: block.text || '' })
      if (state.editing) bindEditableText(h, function (v) { block.text = v }, true)
      return el('section', { class: cls }, [h])
    }

    if (block.type === 'text') {
      var body = el('div', { class: 'block-text', html: block.html || '' })
      if (state.editing) bindEditableText(body, function (v) { block.html = v }, false)
      return el('section', { class: cls }, [body])
    }

    if (block.type === 'image') {
      // Sense foto, el visitant no veu cap requadre buit
      if (!block.src && !state.editing) return null
      return el('section', { class: cls }, [renderImageBlock(block)])
    }

    if (block.type === 'gallery') {
      // Una galeria buida nomes te sentit en mode edicio (per poder-hi
      // afegir fotos); al visitant no li mostrem res.
      if (!(block.images || []).length && !state.editing) return null
      return el('section', { class: cls }, [renderGalleryBlock(block)])
    }

    if (block.type === 'document') {
      if (!block.src && !state.editing) return null
      return el('section', { class: cls }, [renderDocumentBlock(block)])
    }

    return null
  }

  // Baner de la seccio, a dalt de tot com a l'original (les tires de
  // 900x60 amb "Artículos", "Reportajes"...). Si la pagina no te imatge
  // propia, en generem un amb el nom de la seccio.
  function renderBanner() {
    var box = document.getElementById('banner')
    if (!box) return
    box.innerHTML = ''
    var page = state.content.pages[state.slug]
    if (!page) return
    var isHome = state.content.menu[0] && state.content.menu[0].slug === state.slug

    if (page.header && page.header.src) {
      box.appendChild(el('img', {
        src: page.header.src,
        alt: page.header.alt || (isHome ? state.content.site.title : menuLabel(state.slug)) || '',
      }))
      if (state.editing) {
        var buttons = [{
          label: 'Cambiar cabecera',
          onClick: function () {
            uploadImage().then(function (up) {
              if (!up) return
              page.header.src = up.src
              markDirty(); renderBanner()
            })
          },
        }]
        if (state.admin) {
          buttons.push({
            label: 'Quitar', danger: true,
            onClick: function () { delete page.header; markDirty(); renderBanner() },
          })
        }
        box.appendChild(photoActions(buttons))
      }
      return
    }

    var text = el('span', { class: 'banner-text' })
    if (isHome) {
      text.setAttribute('data-edit', 'site.title')
      text.textContent = state.content.site.title || ''
    } else {
      text.textContent = menuLabel(state.slug)
    }
    box.appendChild(el('div', { class: 'banner-fallback' }, [text]))

    if (state.admin) {
      box.appendChild(el('div', { class: 'banner-empty-admin' }, [
        el('span', { text: 'Esta sección usa la cabecera automática.' }),
        el('button', {
          type: 'button', class: 'btn btn-admin btn-sm', text: 'Poner imagen de cabecera (900×60)',
          onclick: function () {
            uploadImage().then(function (up) {
              if (!up) return
              page.header = { src: up.src, alt: '' }
              markDirty(); renderBanner()
            })
          },
        }),
      ]))
    }
  }

  function menuLabel(slug) {
    var m = (state.content.menu || []).find(function (x) { return x.slug === slug })
    return m ? m.label : ''
  }

  var GALLERY_LAYOUTS = [
    ['fila', 'Fotos en fila'],
    ['mosaico', 'Mosaico: 2 apiladas + 1 alta a la derecha'],
    ['mosaico-izquierda', 'Mosaico: 1 alta a la izquierda + 2 apiladas'],
    ['rejilla', 'Rejilla con pies de foto'],
  ]

  function adminBlockControls(page, index) {
    var block = page.blocks[index]
    function move(delta) {
      var j = index + delta
      if (j < 0 || j >= page.blocks.length) return
      var tmp = page.blocks[index]
      page.blocks[index] = page.blocks[j]
      page.blocks[j] = tmp
      markDirty(); renderPage()
    }

    var controls = [
      el('span', { class: 'block-kind', text: BLOCK_KIND[block.type] || block.type }),
    ]

    if (block.type === 'gallery') {
      var select = el('select', { class: 'admin-select', 'aria-label': 'Disposición de las fotos' },
        GALLERY_LAYOUTS.map(function (opt) {
          return el('option', { value: opt[0], selected: (block.layout || 'fila') === opt[0] ? 'selected' : null, text: opt[1] })
        }))
      select.addEventListener('change', function () {
        block.layout = select.value
        markDirty(); renderPage()
      })
      controls.push(select)
    }

    controls.push(
      el('button', {
        type: 'button', class: 'block-ctrl',
        text: block.width === 'half' ? '⇔ Ancho completo' : '⇹ Media columna',
        title: 'Dos cajones de media columna seguidos quedan uno al lado del otro',
        onclick: function () {
          if (block.width === 'half') delete block.width
          else block.width = 'half'
          markDirty(); renderPage()
        },
      }),
      el('button', {
        type: 'button', class: 'block-ctrl', text: '↑ Subir',
        disabled: index === 0, onclick: function () { move(-1) },
      }),
      el('button', {
        type: 'button', class: 'block-ctrl', text: '↓ Bajar',
        disabled: index === page.blocks.length - 1, onclick: function () { move(1) },
      }),
      el('button', {
        type: 'button', class: 'block-ctrl danger', text: '🗑 Borrar',
        onclick: function () {
          if (!confirm('¿Borrar este cajón de «' + (BLOCK_KIND[block.type] || block.type) + '»?')) return
          page.blocks.splice(index, 1)
          markDirty(); renderPage()
        },
      })
    )
    return el('div', { class: 'block-controls' }, controls)
  }

  function addBlockRow(page) {
    function add(type) {
      page.blocks.push(newBlock(type))
      markDirty(); renderPage()
      // Deixa la pagina a baix de tot, on s'acaba d'afegir el bloc
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
    }
    var btn = function (type, label) {
      return el('button', {
        type: 'button', class: 'btn btn-admin btn-sm',
        text: label, onclick: function () { add(type) },
      })
    }
    return el('div', { class: 'add-block' }, [
      el('p', { text: 'Añadir un cajón nuevo a esta página:' }),
      el('div', { class: 'add-block-btns' }, [
        btn('heading', '+ Título'),
        btn('text', '+ Texto'),
        btn('image', '+ Foto grande'),
        btn('gallery', '+ Grupo de fotos (mosaico)'),
        btn('document', '+ Documento PDF'),
      ]),
    ])
  }

  function renderAdminPageBar(slug) {
    var menu = state.content.menu
    var page = state.content.pages[slug]
    var mi = menu.findIndex(function (m) { return m.slug === slug })

    var labelInput = el('input', {
      class: 'admin-input', type: 'text',
      value: (menu[mi] && menu[mi].label) || '',
      placeholder: 'Nombre en el menú',
    })
    labelInput.addEventListener('input', function () {
      if (menu[mi]) { menu[mi].label = labelInput.value; markDirty(); renderNav(); renderBanner() }
    })

    var theme = el('select', { class: 'admin-select', 'aria-label': 'Estilo de la página' }, [
      el('option', { value: 'oscuro', text: 'Fondo negro (como la portada)', selected: page.theme !== 'papel' ? 'selected' : null }),
      el('option', { value: 'papel', text: 'Hoja blanca (como Artículos)', selected: page.theme === 'papel' ? 'selected' : null }),
    ])
    theme.addEventListener('change', function () {
      if (theme.value === 'papel') page.theme = 'papel'
      else delete page.theme
      markDirty(); renderPage()
    })

    function movePage(delta) {
      var j = mi + delta
      if (j < 0 || j >= menu.length) return
      var tmp = menu[mi]; menu[mi] = menu[j]; menu[j] = tmp
      markDirty(); render()
    }

    return el('div', { class: 'admin-pagebar' }, [
      el('h2', { text: 'Administrar páginas' }),
      el('div', { class: 'admin-row' }, [
        el('span', { text: 'Nombre en el menú:' }),
        labelInput,
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '← Mover', disabled: mi <= 0, onclick: function () { movePage(-1) } }),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Mover →', disabled: mi >= menu.length - 1, onclick: function () { movePage(1) } }),
      ]),
      el('div', { class: 'admin-row' }, [
        el('span', { text: 'Estilo:' }),
        theme,
      ]),
      el('div', { class: 'admin-row' }, [
        el('button', { type: 'button', class: 'btn btn-admin btn-sm', text: '+ Crear página nueva', onclick: createPage }),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '🔑 Contraseñas', onclick: changePasswords }),
        el('button', {
          type: 'button', class: 'btn btn-danger btn-sm', text: '🗑 Borrar esta página',
          disabled: menu.length <= 1,
          onclick: function () { deletePage(slug) },
        }),
      ]),
    ])
  }

  // Canviar les contrasenyes des de la web (sense terminal ni cPanel)
  function changePasswords() {
    var overlay = el('div', { class: 'overlay' })
    var error = el('p', { class: 'dialog-error' })
    var who = el('select', { class: 'admin-select', id: 'ccmWho' }, [
      el('option', { value: 'editor', text: 'La del cliente (edita textos y fotos)' }),
      el('option', { value: 'admin', text: 'La mía de administrador' }),
    ])
    var pw = el('input', { type: 'text', id: 'ccmNewPwd', autocomplete: 'new-password', placeholder: 'Mínimo 6 caracteres' })
    function close() { overlay.remove() }
    function submit() {
      error.textContent = ''
      api('POST', 'api.php?r=password', { who: who.value, password: pw.value }).then(function () {
        close()
        toast('Contraseña cambiada', 'ok')
      }).catch(function (err) { error.textContent = err.message })
    }
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit() })
    overlay.appendChild(el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
      el('h2', { text: 'Cambiar contraseña' }),
      el('label', { for: 'ccmWho', text: '¿Cuál?' }),
      who,
      el('label', { for: 'ccmNewPwd', text: 'Contraseña nueva', style: 'margin-top:14px' }),
      pw,
      error,
      el('div', { class: 'dialog-actions' }, [
        el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancelar', onclick: close }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Cambiar', onclick: submit }),
      ]),
    ]))
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close() })
    document.body.appendChild(overlay)
    pw.focus()
  }

  function createPage() {
    var name = prompt('Nombre de la página nueva (por ejemplo: Novedades):', '')
    if (!name) return
    name = name.trim()
    if (!name) return
    var base = slugifyClient(name) || 'pagina'
    var slug = base, n = 2
    while (state.content.pages[slug]) { slug = base + '-' + n; n++ }
    state.content.pages[slug] = {
      title: name, intro: '', blocks: [newBlock('text')],
    }
    state.content.menu.push({ slug: slug, label: name })
    markDirty()
    go(slug) // navega i re-renderitza
  }

  function deletePage(slug) {
    if (state.content.menu.length <= 1) return
    if (!confirm('¿Borrar la página entera y todo su contenido? Esto no se puede deshacer (salvo con las copias de seguridad).')) return
    delete state.content.pages[slug]
    state.content.menu = state.content.menu.filter(function (m) { return m.slug !== slug })
    markDirty()
    go(state.content.menu[0].slug)
  }

  function renderPage() {
    var page = state.content.pages[state.slug]
    main.innerHTML = ''
    main.className = 'page'
    if (!page) {
      main.appendChild(el('p', { text: 'Sección no encontrada.' }))
      return
    }
    main.classList.add(page.theme === 'papel' ? 'theme-papel' : 'theme-oscuro')
    pagePhotos = collectPhotos(page)

    if (state.admin) {
      main.appendChild(renderAdminPageBar(state.slug))
    } else if (state.editing) {
      main.appendChild(el('div', { class: 'help-note' }, [
        el('h2', { text: 'Estás editando esta página' }),
        el('ul', null, [
          el('li', { text: 'Haz clic sobre cualquier texto y escribe encima. Al seleccionar texto sale una barrita para poner negrita, cursiva o enlaces.' }),
          el('li', { text: 'Para las fotos sueltas, usa los botones «Cambiar foto» o «Poner foto».' }),
          el('li', { text: 'En los grupos de fotos (mosaicos), debajo tienes la lista: puedes añadir varias a la vez, cambiarlas de orden y escribir el autor.' }),
          el('li', { text: 'Los documentos PDF (anexos, informes) se suben con «Añadir documento PDF».' }),
          el('li', { text: 'Cuando acabes, pulsa el botón verde «Guardar cambios» de arriba.' }),
        ]),
      ]))
    }

    var inner = el('div', { class: 'page-inner' })
    main.appendChild(inner)

    // El titol es pot deixar buit (p. ex. si ja surt dins la foto de portada)
    if (state.editing || page.title) {
      var title = el('h1', { class: 'page-title', text: page.title || '' })
      if (state.editing) bindEditableText(title, function (v) { page.title = v }, true)
      inner.appendChild(title)
    }

    var intro = el('div', { class: 'page-intro', html: page.intro || '' })
    if (state.editing || page.intro) inner.appendChild(intro)
    if (state.editing) bindEditableText(intro, function (v) { page.intro = v }, false)

    ;(page.blocks || []).forEach(function (block, index) {
      var node = renderBlock(block)
      if (!node) return
      if (state.admin) node.insertBefore(adminBlockControls(page, index), node.firstChild)
      inner.appendChild(node)
    })

    if (state.admin) inner.appendChild(addBlockRow(page))
  }

  function renderSiteFields() {
    document.querySelectorAll('[data-edit]').forEach(function (node) {
      var key = node.getAttribute('data-edit').split('.')[1]
      node.textContent = state.content.site[key] || ''
      if (state.editing) {
        bindEditableText(node, function (v) { state.content.site[key] = v }, true)
      } else {
        node.removeAttribute('contenteditable')
        node.removeAttribute('data-editable')
      }
    })
    var st = state.content.site
    document.title = (st.title || 'CC Mallorca') + (st.subtitle ? ' · ' + st.subtitle : '')

    var emailLink = document.getElementById('footerEmail')
    if (emailLink && st.email) {
      emailLink.href = 'mailto:' + st.email
      emailLink.textContent = st.email
    }
  }

  function render() {
    if (!state.content) return
    renderNav()
    renderBanner()
    renderSiteFields()
    renderPage()
    // Titol de la pestanya per pagina (util per a l'historial i marcadors)
    var page = state.content.pages[state.slug]
    if (page && page.title && state.slug !== 'inicio') {
      document.title = page.title + ' · ' + (state.content.site.title || 'CC Mallorca')
    }
  }

  // -------------------------------------------------- barra de format (text ric)

  var formatBar = null

  function buildFormatBar() {
    function cmd(command, value) {
      return function (e) {
        e.preventDefault()
        document.execCommand(command, false, value || null)
        var node = document.activeElement
        if (node && node.hasAttribute && node.hasAttribute('data-editable')) {
          node.dispatchEvent(new Event('input'))
        }
      }
    }

    formatBar = el('div', { class: 'format-bar', role: 'toolbar', 'aria-label': 'Formato del texto' }, [
      el('button', { type: 'button', title: 'Negrita', onmousedown: cmd('bold'), html: '<strong>N</strong>' }),
      el('button', { type: 'button', title: 'Cursiva', onmousedown: cmd('italic'), html: '<em>C</em>' }),
      el('button', { type: 'button', title: 'Lista', onmousedown: cmd('insertUnorderedList'), text: '☰' }),
      el('button', {
        type: 'button', title: 'Poner enlace', text: '🔗',
        onmousedown: function (e) {
          e.preventDefault()
          var url = prompt('Dirección del enlace (por ejemplo https://…):', 'https://')
          if (url) cmd('createLink', url)(e)
        },
      }),
      el('button', { type: 'button', title: 'Deshacer', onmousedown: cmd('undo'), text: '↶' }),
    ])
    document.body.appendChild(formatBar)
  }

  function positionFormatBar() {
    if (!state.editing || !formatBar) return
    var sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      formatBar.classList.remove('visible')
      return
    }
    var anchor = sel.anchorNode
    var host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
    host = host && host.closest ? host.closest('[data-editable][contenteditable="true"]') : null
    if (!host) {
      formatBar.classList.remove('visible')
      return
    }
    var rect = sel.getRangeAt(0).getBoundingClientRect()
    formatBar.classList.add('visible')
    var top = window.scrollY + rect.top - formatBar.offsetHeight - 10
    formatBar.style.top = Math.max(window.scrollY + 84, top) + 'px'
    formatBar.style.left = Math.max(10, Math.min(
      window.innerWidth - formatBar.offsetWidth - 10,
      rect.left
    )) + 'px'
  }

  document.addEventListener('selectionchange', function () {
    if (state.editing) positionFormatBar()
  })

  // ------------------------------------------------------------- barra d'edicio

  var editbar = null

  function updateEditbar() {
    if (!editbar) return
    var status = editbar.querySelector('.editbar-status')
    var label = editbar.querySelector('.editbar-label')
    var saveBtn = editbar.querySelector('[data-action="save"]')
    var discardBtn = editbar.querySelector('[data-action="discard"]')

    status.classList.toggle('dirty', state.dirty)
    label.textContent = state.saving
      ? 'Guardando…'
      : state.dirty ? 'Tienes cambios sin guardar' : 'Todo guardado'
    saveBtn.disabled = !state.dirty || state.saving
    discardBtn.disabled = !state.dirty || state.saving
  }

  function buildEditbar() {
    editbar = el('div', { class: 'editbar' }, [
      el('div', { class: 'editbar-inner wrap' }, [
        el('div', { class: 'editbar-status' }, [
          el('span', { class: 'dot', 'aria-hidden': 'true' }),
          el('span', { class: 'editbar-label', text: 'Todo guardado' }),
          state.admin ? el('span', { class: 'admin-badge', text: 'ADMINISTRADOR' }) : null,
        ]),
        el('div', { class: 'editbar-actions' }, [
          el('button', {
            type: 'button', class: 'btn btn-primary btn-lg', 'data-action': 'save',
            text: 'Guardar cambios', onclick: save,
          }),
          el('button', {
            type: 'button', class: 'btn btn-danger', 'data-action': 'discard',
            text: 'Descartar', onclick: discard,
          }),
          el('button', {
            type: 'button', class: 'btn btn-ghost', 'data-action': 'exit',
            text: 'Salir', onclick: exitEditing,
          }),
        ]),
      ]),
    ])
    document.body.appendChild(editbar)
  }

  function save() {
    if (state.saving || !state.dirty) return
    state.saving = true
    updateEditbar()
    // L'admin guarda l'estructura sencera; el client nomes els valors.
    var endpoint = state.admin ? 'api.php?r=structure' : 'api.php?r=content'
    api('PUT', endpoint, state.content).then(function (res) {
      state.content = res.content
      // La pagina actual pot haver canviat d'slug (l'admin pot haver-la
      // reanomenat); si ja no existeix, anem a la primera del menu.
      if (!state.content.pages[state.slug]) {
        state.slug = (state.content.menu[0] && state.content.menu[0].slug) || 'inicio'
      }
      state.dirty = false
      state.saving = false
      updateEditbar()
      render()
      toast('Cambios guardados', 'ok')
    }).catch(function (err) {
      state.saving = false
      updateEditbar()
      toast('No se pudo guardar: ' + err.message, 'err')
    })
  }

  function discard() {
    if (!state.dirty) return
    if (!confirm('¿Descartar los cambios y volver a como estaba guardado?')) return
    loadContent().then(function () {
      state.dirty = false
      updateEditbar()
      render()
      toast('Cambios descartados')
    })
  }

  function enterEditing(role) {
    state.editing = true
    state.admin = role === 'admin'
    document.body.classList.add('editing')
    if (!editbar) buildEditbar()
    editbar.classList.toggle('is-admin', state.admin)
    if (!formatBar) buildFormatBar()
    editbar.style.display = ''
    updateEditbar()
    render()
  }

  function exitEditing() {
    if (state.dirty && !confirm('Tienes cambios sin guardar. ¿Salir y perderlos?')) return
    api('POST', 'api.php?r=logout').catch(function () {})
    state.editing = false
    state.admin = false
    state.dirty = false
    document.body.classList.remove('editing')
    // Destruim la barra perque la propera entrada la reconstrueixi amb
    // el rol correcte (i sense la insignia d'admin si toca).
    if (editbar) { editbar.remove(); editbar = null }
    if (formatBar) formatBar.classList.remove('visible')
    loadContent().then(render)
    toast('Has salido del modo edición')
  }

  window.addEventListener('beforeunload', function (e) {
    if (state.dirty) {
      e.preventDefault()
      e.returnValue = ''
    }
  })

  // --------------------------------------------------------------- entrada

  function askPassword() {
    var overlay = el('div', { class: 'overlay' })
    var error = el('p', { class: 'dialog-error' })
    var input = el('input', { type: 'password', id: 'ccmPwd', autocomplete: 'current-password' })

    function close() { overlay.remove() }

    function submit() {
      error.textContent = ''
      api('POST', 'api.php?r=login', { password: input.value }).then(function (res) {
        close()
        enterEditing(res.role)
        toast(res.role === 'admin' ? 'Modo administrador' : 'Ya puedes editar la web', 'ok')
      }).catch(function (err) {
        error.textContent = err.message
        input.select()
      })
    }

    var dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
      el('h2', { text: 'Editar la web' }),
      el('p', { text: 'Escribe la contraseña para poder cambiar textos y fotos.' }),
      el('label', { for: 'ccmPwd', text: 'Contraseña' }),
      input,
      error,
      el('div', { class: 'dialog-actions' }, [
        el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancelar', onclick: close }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Entrar', onclick: submit }),
      ]),
    ])

    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit() })
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close() })
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) }
    })

    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    input.focus()
  }

  document.getElementById('editEntry').addEventListener('click', askPassword)

  // Ctrl+S (o Cmd+S) guarda, com a FrontPage
  document.addEventListener('keydown', function (e) {
    if (state.editing && (e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      save()
    }
  })

  // ------------------------------------------------------- botó "tornar amunt"
  // Els articles son molt llargs; un boto per tornar a dalt ajuda molt.
  var toTop = el('button', {
    type: 'button', class: 'to-top', 'aria-label': 'Volver arriba', text: '↑',
  })
  toTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
  document.body.appendChild(toTop)
  window.addEventListener('scroll', function () {
    if (window.scrollY > 600) toTop.classList.add('visible')
    else toTop.classList.remove('visible')
  })

  // ------------------------------------------------------------- arrencada

  function loadContent() {
    return fetch('api.php?r=content&t=' + Date.now(), { credentials: 'same-origin' })
      .then(function (r) { return r.json() })
      .then(function (data) {
        state.content = data
        state.slug = currentSlug()
        return data
      })
  }

  loadContent().then(function () {
    render()
    // Si ja hi ha sessio oberta (o s'ha entrat amb ?edit=1) passem a mode edicio
    var wants = location.search.indexOf('edit=1') !== -1 || location.hash === '#edit'
    return api('GET', 'api.php?r=session').then(function (s) {
      if (s.authenticated) enterEditing(s.role)
      else if (wants) askPassword()
    }).catch(function () {})
  }).catch(function () {
    main.innerHTML = ''
    main.appendChild(el('p', { text: 'No se ha podido cargar el contenido de la web.' }))
  })
})()
