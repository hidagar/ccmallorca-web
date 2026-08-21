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

  function pickFile(accept) {
    return new Promise(function (resolve) {
      var input = el('input', { type: 'file', accept: accept })
      input.style.display = 'none'
      document.body.appendChild(input)
      input.addEventListener('change', function () {
        var file = input.files && input.files[0]
        input.remove()
        if (!file) return resolve(null)
        var reader = new FileReader()
        reader.onload = function () { resolve({ name: file.name, data: String(reader.result) }) }
        reader.onerror = function () { resolve(null) }
        reader.readAsDataURL(file)
      })
      input.click()
    })
  }

  function pickImage() {
    return pickFile('image/jpeg,image/png,image/gif,image/webp')
  }

  // Redueix la foto al navegador abans de pujar-la. El client puja fotos
  // de camera enormes (4000px, 8+ MB): sense aixo li donarien error de
  // mida o farien la web lentissima. Maxim 1600px pel costat gran,
  // JPEG al 85%. Els GIF no es toquen (poden ser animats) i si per
  // qualsevol motiu falla, es puja l'original tal qual.
  var MAX_SIDE = 1600
  var SMALL_ENOUGH = 700 * 1024 // ~500 KB reals en base64

  function prepareImage(picked) {
    return new Promise(function (resolve) {
      if (!picked || picked.data.indexOf('data:image/gif') === 0) {
        return resolve(picked)
      }
      var probe = new Image()
      probe.onload = function () {
        var w = probe.naturalWidth
        var h = probe.naturalHeight
        if ((w <= MAX_SIDE && h <= MAX_SIDE) && picked.data.length <= SMALL_ENOUGH) {
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
          })
        } catch (e) {
          resolve(picked)
        }
      }
      probe.onerror = function () { resolve(picked) }
      probe.src = picked.data
    })
  }

  function uploadImage() {
    return pickImage().then(prepareImage).then(function (picked) {
      if (!picked) return null
      toast('Subiendo la foto…')
      return api('POST', 'api/upload', picked).then(function (res) {
        toast('Foto subida', 'ok')
        return res.src
      }).catch(function (err) {
        toast(err.message, 'err')
        return null
      })
    })
  }

  function uploadDocument() {
    return pickFile('application/pdf').then(function (picked) {
      if (!picked) return null
      toast('Subiendo el documento…')
      return api('POST', 'api/upload', {
        name: picked.name,
        data: picked.data,
        kind: 'document',
      }).then(function (res) {
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
      })
    }))
  }

  // ----------------------------------------------------- ampliar fotos (lightbox)

  function openLightbox(src, caption) {
    var overlay = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Foto ampliada' })
    var closeBtn = el('button', {
      type: 'button', class: 'lightbox-close', 'aria-label': 'Cerrar', text: '✕',
    })
    var img = el('img', { src: src, alt: caption || '' })
    var content = el('div', { class: 'lightbox-content' }, [img])
    if (caption) content.appendChild(el('p', { class: 'lightbox-caption', text: caption }))

    function close() {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
    }
    function onKey(e) { if (e.key === 'Escape') close() }

    closeBtn.addEventListener('click', close)
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close() })
    document.addEventListener('keydown', onKey)

    overlay.appendChild(closeBtn)
    overlay.appendChild(content)
    document.body.appendChild(overlay)
  }

  // Crea la imatge amb el credit d'autor superposat. Fora del mode edicio,
  // en clicar-la s'amplia (lightbox); en edicio el credit es editable.
  function photoImage(obj, alt) {
    var img = el('img', { src: obj.src, alt: alt || obj.alt || '', loading: 'lazy' })

    if (!state.editing) {
      img.classList.add('zoomable')
      img.setAttribute('title', 'Clic para ampliar')
      img.addEventListener('click', function () {
        openLightbox(obj.src, obj.caption || '')
      })
      // Contenidor propi img+credit: el credit sempre queda sobre la foto,
      // independentment del peu, i sense dependre de CSS :has().
      var holder = el('div', { class: 'img-holder' }, [img])
      if (obj.credit) {
        holder.appendChild(el('span', { class: 'photo-credit', text: 'Foto: ' + obj.credit }))
      }
      return [holder]
    }

    // Mode edicio: casella d'autor en flux normal, sota la foto.
    var creditInput = el('input', {
      type: 'text', class: 'credit-input',
      placeholder: 'Autor de la foto (ej: L. Ramírez)',
      value: obj.credit || '',
    })
    creditInput.addEventListener('input', function () {
      obj.credit = creditInput.value
      markDirty()
    })
    return [img, creditInput]
  }

  function renderImageBlock(block) {
    var figure = el('figure', { class: 'photo-wrap' })

    function paint() {
      figure.innerHTML = ''
      if (block.src) {
        photoImage(block).forEach(function (n) { figure.appendChild(n) })
      } else {
        figure.appendChild(el('div', {
          class: 'photo-empty',
          text: state.editing ? 'Sin foto todavía. Pulsa «Poner foto».' : '',
        }))
      }

      var caption = el('figcaption', { text: block.caption || '' })
      if (state.editing || block.caption) figure.appendChild(caption)
      if (state.editing) {
        bindEditableText(caption, function (v) { block.caption = v }, true)
        caption.setAttribute('aria-label', 'Texto debajo de la foto')

        figure.appendChild(photoActions([
          {
            label: block.src ? 'Cambiar foto' : 'Poner foto',
            onClick: function () {
              uploadImage().then(function (src) {
                if (!src) return
                block.src = src
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
              markDirty()
              paint()
            },
          } : null,
        ].filter(Boolean)))
      }
    }

    paint()
    return figure
  }

  function renderGalleryBlock(block) {
    var grid = el('div', { class: 'gallery' })

    function paint() {
      grid.innerHTML = ''
      var images = block.images || []

      if (!images.length && !state.editing) {
        grid.appendChild(el('p', { class: 'gallery-empty photo-empty', text: 'Todavía no hay fotos en la galería.' }))
      }

      images.forEach(function (img, index) {
        var fig = el('figure', { class: 'photo-wrap' }, photoImage(img))
        var caption = el('figcaption', { text: img.caption || '' })
        if (state.editing || img.caption) fig.appendChild(caption)

        if (state.editing) {
          bindEditableText(caption, function (v) { img.caption = v }, true)
          fig.appendChild(photoActions([
            {
              label: 'Cambiar',
              onClick: function () {
                uploadImage().then(function (src) {
                  if (!src) return
                  img.src = src
                  markDirty()
                  paint()
                })
              },
            },
            {
              label: 'Quitar',
              danger: true,
              onClick: function () {
                if (!confirm('¿Quitar esta foto de la galería?')) return
                block.images.splice(index, 1)
                markDirty()
                paint()
              },
            },
          ]))
        }
        grid.appendChild(fig)
      })

      if (state.editing) {
        grid.appendChild(el('button', {
          type: 'button',
          class: 'gallery-add',
          text: '+ Añadir foto',
          onclick: function () {
            uploadImage().then(function (src) {
              if (!src) return
              if (!block.images) block.images = []
              block.images.push({ src: src, alt: '', caption: '' })
              markDirty()
              paint()
            })
          },
        }))
      }
    }

    paint()
    return grid
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
    if (block.type === 'heading') {
      var h = el('h2', { text: block.text || '' })
      if (state.editing) bindEditableText(h, function (v) { block.text = v }, true)
      return el('section', { class: 'block' }, [h])
    }

    if (block.type === 'text') {
      var body = el('div', { class: 'block-text', html: block.html || '' })
      if (state.editing) bindEditableText(body, function (v) { block.html = v }, false)
      return el('section', { class: 'block' }, [body])
    }

    if (block.type === 'image') {
      return el('section', { class: 'block' }, [renderImageBlock(block)])
    }

    if (block.type === 'gallery') {
      // Una galeria buida nomes te sentit en mode edicio (per poder-hi
      // afegir fotos); al visitant no li mostrem res.
      if (!(block.images || []).length && !state.editing) return null
      return el('section', { class: 'block' }, [renderGalleryBlock(block)])
    }

    if (block.type === 'document') {
      if (!block.src && !state.editing) return null
      return el('section', { class: 'block' }, [renderDocumentBlock(block)])
    }

    return null
  }

  function renderHeader(page) {
    if (!page.header || !page.header.src) {
      // Sense capçalera: nomes l'admin veu el boto per posar-ne una.
      if (!state.admin) return null
      return el('div', { class: 'page-header-img' }, [
        el('div', { class: 'photo-empty', text: 'Sin imagen de cabecera.' }),
        photoActions([{
          label: 'Poner imagen de cabecera',
          onClick: function () {
            uploadImage().then(function (src) {
              if (!src) return
              page.header = { src: src, alt: '' }
              markDirty(); renderPage()
            })
          },
        }]),
      ])
    }
    var wrap = el('div', { class: 'page-header-img photo-wrap' }, [
      el('img', { src: page.header.src, alt: page.header.alt || '' }),
    ])
    if (state.editing) {
      var buttons = [{
        label: 'Cambiar imagen de cabecera',
        onClick: function () {
          uploadImage().then(function (src) {
            if (!src) return
            page.header.src = src
            markDirty(); renderPage()
          })
        },
      }]
      if (state.admin) {
        buttons.push({
          label: 'Quitar cabecera', danger: true,
          onClick: function () {
            delete page.header
            markDirty(); renderPage()
          },
        })
      }
      wrap.appendChild(photoActions(buttons))
    }
    return wrap
  }

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
    return el('div', { class: 'block-controls' }, [
      el('span', { class: 'block-kind', text: BLOCK_KIND[block.type] || block.type }),
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
      }),
    ])
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
        btn('image', '+ Foto'),
        btn('gallery', '+ Galería de fotos'),
        btn('document', '+ Documento PDF'),
      ]),
    ])
  }

  function renderAdminPageBar(slug) {
    var menu = state.content.menu
    var mi = menu.findIndex(function (m) { return m.slug === slug })

    var labelInput = el('input', {
      class: 'admin-input', type: 'text',
      value: (menu[mi] && menu[mi].label) || '',
      placeholder: 'Nombre en el menú',
    })
    labelInput.addEventListener('input', function () {
      if (menu[mi]) { menu[mi].label = labelInput.value; markDirty(); renderNav() }
    })

    function movePage(delta) {
      var j = mi + delta
      if (j < 0 || j >= menu.length) return
      var tmp = menu[mi]; menu[mi] = menu[j]; menu[j] = tmp
      markDirty(); renderNav(); renderPage()
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
        el('button', { type: 'button', class: 'btn btn-admin btn-sm', text: '+ Crear página nueva', onclick: createPage }),
        el('button', {
          type: 'button', class: 'btn btn-danger btn-sm', text: '🗑 Borrar esta página',
          disabled: menu.length <= 1,
          onclick: function () { deletePage(slug) },
        }),
      ]),
    ])
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
    if (!page) {
      main.appendChild(el('p', { text: 'Sección no encontrada.' }))
      return
    }

    if (state.admin) {
      main.appendChild(renderAdminPageBar(state.slug))
    } else if (state.editing) {
      main.appendChild(el('div', { class: 'help-note' }, [
        el('h2', { text: 'Estás editando esta página' }),
        el('ul', null, [
          el('li', { text: 'Haz clic sobre cualquier texto y escribe encima.' }),
          el('li', { text: 'Para las fotos, usa los botones «Cambiar foto» o «Poner foto».' }),
          el('li', { text: 'En cada foto puedes escribir el autor en la casilla «Autor de la foto».' }),
          el('li', { text: 'Al final de cada página hay una galería: con «+ Añadir foto» puedes poner todas las fotos que quieras.' }),
          el('li', { text: 'Los documentos PDF (anexos, informes) se suben con «Añadir documento PDF».' }),
          el('li', { text: 'Cuando acabes, pulsa el botón verde «Guardar cambios» de arriba.' }),
        ]),
      ]))
    }

    var header = renderHeader(page)
    if (header) main.appendChild(header)

    var inner = el('div', { class: 'page-inner' + (page.header && page.header.src ? ' has-header' : '') })
    main.appendChild(inner)

    var title = el('h1', { class: 'page-title', text: page.title || '' })
    if (state.editing) bindEditableText(title, function (v) { page.title = v }, true)
    inner.appendChild(title)

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
    var endpoint = state.admin ? 'api/structure' : 'api/content'
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
    api('POST', 'api/logout').catch(function () {})
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
      api('POST', 'api/login', { password: input.value }).then(function (res) {
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

  var navToggle = document.getElementById('navToggle')
  navToggle.addEventListener('click', function () {
    var open = navEl.classList.toggle('open')
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
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
    return fetch('content.json?t=' + Date.now(), { credentials: 'same-origin' })
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
    return api('GET', 'api/session').then(function (s) {
      if (s.authenticated) enterEditing(s.role)
      else if (wants) askPassword()
    }).catch(function () {})
  }).catch(function () {
    main.innerHTML = ''
    main.appendChild(el('p', { text: 'No se ha podido cargar el contenido de la web.' }))
  })
})()
