// Website editor for healingsanctuary.in. Reads the forms from .pages.yml (the same
// file Pages CMS uses), shows a live preview rendered in the browser, and publishes
// every change as one commit to the GitHub repository.
(function () {
  var OWNER = 'mahalakshmirajagopal';
  var REPO = 'mahalakshmirajagopal.github.io';
  var BRANCH = 'main';
  var LIVE = 'https://healingsanctuary.in';
  var API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
  var TOKEN_KEY = 'editor-token';
  var DRAFT_KEY = 'editor-draft';

  // Where the preview scrolls when a form is opened.
  var ANCHORS = { top: 'top', about: 'about', sessions: 'sessions', workshops: 'workshops', meditation: 'meditation', videos: 'videos', testimonials: 'testimonials', contact: 'contact' };

  var token = null;
  var schema = [];          // content entries from .pages.yml
  var templates = {};       // template files used by the renderer
  var styles = '', script = '';
  var data = {};            // every _data file, parsed: { name: value }
  var originals = {};       // for editable files: { name: { path, sha, text } }
  var images = [];          // file names in /images
  var pendingImages = {};   // new photos not yet published: { "/images/x.jpg": { dataUrl, base64 } }
  var current = null;       // content entry being edited
  var previewPage = 'index.html';
  var device = 'desktop';

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function store(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) {}
  }
  function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  // ---------- GitHub ----------

  function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path.indexOf('http') === 0 ? path : API + path, {
      method: opts.method || 'GET', headers: headers, cache: 'no-store',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (!r.ok) {
        var err = new Error('GitHub replied ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.status === 204 ? null : r.json();
    });
  }
  function decode(b64) {
    var bin = atob(b64.replace(/\n/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function getFile(path) {
    return api('/contents/' + encodeURI(path) + '?ref=' + BRANCH).then(function (f) {
      return { path: path, sha: f.sha, text: decode(f.content) };
    });
  }
  function listDir(path) {
    return api('/contents/' + encodeURI(path) + '?ref=' + BRANCH).catch(function () { return []; });
  }

  // ---------- Loading ----------

  function load() {
    $('loading').hidden = false;
    $('loading').textContent = 'Loading the website…';
    return Promise.all([getFile('.pages.yml'), getFile('styles.css'), getFile('script.js'), getFile('index.html'), getFile('testimonials.html'),
      listDir('_layouts'), listDir('_includes'), listDir('_data'), listDir('images')])
      .then(function (r) {
        schema = jsyaml.load(r[0].text).content || [];
        styles = r[1].text;
        script = r[2].text;
        templates = { 'index.html': r[3].text, 'testimonials.html': r[4].text };
        images = r[8].filter(function (f) { return f.type === 'file' && /\.(jpe?g|png|webp|gif)$/i.test(f.name); }).map(function (f) { return f.name; });
        var parts = r[5].concat(r[6]).filter(function (f) { return f.type === 'file'; })
          .map(function (f) { return getFile(f.path).then(function (x) { templates[f.path] = x.text; }); });
        var dataFiles = r[7].filter(function (f) { return /\.ya?ml$/.test(f.name); })
          .map(function (f) {
            return getFile(f.path).then(function (x) {
              var name = f.name.replace(/\.ya?ml$/, '');
              data[name] = jsyaml.load(x.text) || {};
              originals[name] = { path: f.path, sha: x.sha, text: x.text };
            });
          });
        return Promise.all(parts.concat(dataFiles));
      })
      .then(function () {
        pendingImages = {};
        restoreDraft();
        buildSections();
        openSection(current ? schema.filter(function (s) { return s.name === current.name; })[0] || schema[0] : schema[0]);
        updateStatus();
        $('loading').hidden = true;
        $('app').hidden = false;
      });
  }

  function nameOf(entry) { return entry.path.split('/').pop().replace(/\.ya?ml$/, ''); }

  // ---------- Changes and drafts ----------

  function dump(value) { return jsyaml.dump(value, { lineWidth: -1, noRefs: true, quotingType: '"' }); }
  function changedNames() {
    return schema.map(nameOf).filter(function (n) {
      return originals[n] && dump(data[n]) !== dump(jsyaml.load(originals[n].text) || {});
    });
  }
  function saveDraft() {
    var changed = changedNames();
    if (!changed.length) { store(DRAFT_KEY, null); return; }
    var draft = { saved: Date.now(), files: {} };
    changed.forEach(function (n) { draft.files[n] = { sha: originals[n].sha, value: data[n] }; });
    store(DRAFT_KEY, JSON.stringify(draft));
  }
  function restoreDraft() {
    var raw = stored(DRAFT_KEY);
    if (!raw) return;
    try {
      var draft = JSON.parse(raw), stale = [];
      Object.keys(draft.files).forEach(function (n) {
        if (!originals[n]) return;
        if (draft.files[n].sha !== originals[n].sha) stale.push(n);
        else data[n] = draft.files[n].value;
      });
      if (stale.length) flash('Some unpublished changes were left out, because those sections were changed elsewhere since.');
      else flash('Your unpublished changes from last time are back.');
    } catch (e) { store(DRAFT_KEY, null); }
  }

  var flashTimer;
  function flash(msg) {
    var s = $('status');
    s.textContent = msg;
    s.className = 'status';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(updateStatus, 5000);
  }
  function updateStatus() {
    var changed = changedNames();
    var s = $('status');
    var labels = changed.map(function (n) { return labelFor(n); });
    s.textContent = changed.length ? 'Not published yet: ' + labels.join(', ') : 'Everything is published';
    s.className = 'status' + (changed.length ? ' dirty' : '');
    $('publish').disabled = !changed.length;
    $('discard').disabled = !changed.length;
    Array.prototype.forEach.call(document.querySelectorAll('.sections button'), function (b) {
      var dot = b.querySelector('.dot');
      if (dot) dot.hidden = changed.indexOf(b.dataset.name) === -1;
    });
  }
  function labelFor(name) {
    var e = schema.filter(function (s) { return nameOf(s) === name; })[0];
    return e ? e.label.replace(/\s*\(.*\)$/, '') : name;
  }

  var changeTimer;
  function changed() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(function () { saveDraft(); updateStatus(); renderPreview(); }, 250);
  }

  // ---------- Sections and forms ----------

  function buildSections() {
    var nav = $('sections');
    nav.textContent = '';
    schema.forEach(function (entry) {
      nav.appendChild(el('button', { type: 'button', 'data-name': nameOf(entry), onclick: function () { openSection(entry); } },
        [el('span', { text: entry.label.replace(/\s*\(.*\)$/, '') }), el('span', { class: 'dot', hidden: true })]));
    });
  }

  function openSection(entry) {
    current = entry;
    var name = nameOf(entry);
    Array.prototype.forEach.call(document.querySelectorAll('.sections button'), function (b) {
      b.classList.toggle('on', b.dataset.name === name);
    });
    $('section-title').textContent = entry.label;
    var form = $('form');
    form.textContent = '';
    if (!data[name]) data[name] = {};
    entry.fields.forEach(function (f) { form.appendChild(fieldFor(f, data[name], [name])); });
    $('form').parentNode.scrollTop = 0;
    if (ANCHORS[name]) setPage('index.html', ANCHORS[name]);
    updateStatus();
  }

  // Builds the input for one field. obj[f.name] holds its value; path is used to spot colour fields.
  function fieldFor(f, obj, path) {
    var wrap = el('div', { class: 'field' });
    var p = path.concat(f.name);
    if (f.list) {
      wrap.appendChild(el('div', { class: 'label', text: f.label }));
      if (f.description) wrap.appendChild(el('p', { class: 'hint', text: f.description }));
      if (!Array.isArray(obj[f.name])) obj[f.name] = [];
      wrap.appendChild(f.type === 'object' ? objectList(f, obj[f.name], p) : plainList(f, obj[f.name], p));
      return wrap;
    }
    if (f.type === 'boolean') {
      var box = el('input', { type: 'checkbox' });
      box.checked = !!obj[f.name];
      box.addEventListener('change', function () { obj[f.name] = box.checked; changed(); });
      wrap.appendChild(el('label', { class: 'toggle' }, [box, f.label]));
      return wrap;
    }
    var id = 'f-' + p.join('-');
    wrap.appendChild(el('label', { for: id, text: f.label }));
    if (f.description) wrap.appendChild(el('p', { class: 'hint', text: f.description }));
    if (f.type === 'object') {
      if (!obj[f.name] || typeof obj[f.name] !== 'object') obj[f.name] = {};
      var group = el('div', { class: 'group' });
      f.fields.forEach(function (sub) { group.appendChild(fieldFor(sub, obj[f.name], p)); });
      wrap.appendChild(group);
      return wrap;
    }
    wrap.appendChild(inputFor(f, obj, f.name, id, p));
    return wrap;
  }

  function inputFor(f, obj, key, id, path) {
    var value = obj[key] == null ? '' : obj[key];
    if (path[0] === 'theme' && path[1] === 'colours') return colourInput(obj, key, id);
    if (f.type === 'image') return imageInput(obj, key);
    if (f.type === 'select') {
      var sel = el('select', { id: id });
      ((f.options && f.options.values) || []).forEach(function (v) {
        var o = el('option', { value: v, text: v });
        if (String(v) === String(value)) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { obj[key] = sel.value; changed(); if (path[0] === 'theme') refreshColourHints(); });
      return sel;
    }
    if (f.type === 'text') {
      var ta = el('textarea', { id: id, rows: Math.min(10, Math.max(3, Math.ceil(String(value).length / 55))) });
      ta.value = value;
      ta.addEventListener('input', function () { obj[key] = ta.value; changed(); });
      return ta;
    }
    var input = el('input', { id: id, type: f.type === 'number' ? 'number' : 'text' });
    input.value = value;
    input.addEventListener('input', function () {
      obj[key] = f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value;
      changed();
    });
    return input;
  }

  // Colour boxes: empty means "use the colour theme's colour", shown as the placeholder.
  function themeDefault(key) {
    var t = data.themes && data.theme && data.themes[data.theme.colour_theme];
    return (t && t[key]) || '';
  }
  function colourInput(obj, key, id) {
    var row = el('div', { class: 'colour' });
    var picker = el('input', { type: 'color', 'aria-label': 'Pick a colour' });
    var text = el('input', { id: id, type: 'text', 'data-colour-key': key });
    var clear = el('button', { type: 'button', class: 'btn small', text: 'Use theme colour' });
    function sync() {
      text.placeholder = themeDefault(key) + ' (from the colour theme)';
      var v = obj[key] || themeDefault(key);
      if (/^#[0-9a-f]{6}$/i.test(v)) picker.value = v;
      clear.hidden = !obj[key];
    }
    text.value = obj[key] || '';
    picker.addEventListener('input', function () { obj[key] = picker.value; text.value = picker.value; sync(); changed(); });
    text.addEventListener('input', function () { obj[key] = text.value.trim(); sync(); changed(); });
    clear.addEventListener('click', function () { obj[key] = ''; text.value = ''; sync(); changed(); });
    text._sync = sync;
    sync();
    row.appendChild(picker); row.appendChild(text); row.appendChild(clear);
    return row;
  }
  function refreshColourHints() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-colour-key]'), function (t) { if (t._sync) t._sync(); });
  }

  function imageSrc(path) {
    if (!path) return '';
    if (pendingImages[path]) return pendingImages[path].dataUrl;
    return LIVE + (path.charAt(0) === '/' ? path : '/' + path);
  }
  function imageInput(obj, key) {
    var img = el('img', { alt: '' });
    var name = el('span', { class: 'file-name' });
    function show() {
      img.src = imageSrc(obj[key]);
      name.textContent = obj[key] ? obj[key].split('/').pop() : 'No photo';
    }
    var choose = el('button', { type: 'button', class: 'btn small', text: 'Change photo', onclick: function () {
      openPicker(function (path) { obj[key] = path; show(); changed(); });
    } });
    show();
    return el('div', { class: 'image' }, [img, el('div', { class: 'image-tools' }, [choose, name])]);
  }

  function moveTools(arr, i, rerender) {
    function move(d) {
      var j = i + d;
      if (j < 0 || j >= arr.length) return;
      var x = arr[i]; arr[i] = arr[j]; arr[j] = x;
      rerender(); changed();
    }
    return [
      el('button', { type: 'button', class: 'btn small', title: 'Move up', 'aria-label': 'Move up', text: '↑', disabled: i === 0, onclick: function (e) { e.stopPropagation(); move(-1); } }),
      el('button', { type: 'button', class: 'btn small', title: 'Move down', 'aria-label': 'Move down', text: '↓', disabled: i === arr.length - 1, onclick: function (e) { e.stopPropagation(); move(1); } }),
      el('button', { type: 'button', class: 'btn small danger', title: 'Remove', 'aria-label': 'Remove', text: '✕', onclick: function (e) {
        e.stopPropagation();
        if (!confirm('Remove this item?')) return;
        arr.splice(i, 1); rerender(); changed();
      } })
    ];
  }

  function plainList(f, arr, path) {
    var box = el('div', { class: 'list-plain' });
    function render() {
      box.textContent = '';
      arr.forEach(function (v, i) {
        var input = inputFor({ type: f.type, options: f.options }, arr, i, 'f-' + path.join('-') + '-' + i, path);
        box.appendChild(el('div', { class: 'row' }, [input, el('div', { class: 'row-tools' }, moveTools(arr, i, render))]));
      });
      box.appendChild(el('button', { type: 'button', class: 'btn small add', text: '+ Add', onclick: function () {
        arr.push(''); render(); changed();
        var last = box.querySelectorAll('textarea, input');
        if (last.length) last[last.length - 1].focus();
      } }));
    }
    render();
    return box;
  }

  function objectList(f, arr, path) {
    var box = el('div', { class: 'list' });
    var open = {};
    function title(item, i) {
      var named = f.fields.filter(function (x) { return x.name === 'title' || x.name === 'name'; })[0];
      var first = named || f.fields.filter(function (x) { return x.type === 'string' || x.type === 'text'; })[0];
      var t = first && item[first.name];
      return t ? String(t) : 'Item ' + (i + 1);
    }
    function render() {
      box.textContent = '';
      arr.forEach(function (item, i) {
        var nameEl = el('span', { class: 'name', text: title(item, i) });
        var head = el('div', { class: 'item-head' }, [el('span', { class: 'caret', text: open[i] ? '▾' : '▸' }), nameEl].concat(moveTools(arr, i, render)));
        var body = el('div', { class: 'item-body' });
        f.fields.forEach(function (sub) { body.appendChild(fieldFor(sub, item, path.concat(String(i)))); });
        body.addEventListener('input', function () { nameEl.textContent = title(item, i); });
        var card = el('div', { class: 'item' + (open[i] ? '' : ' closed') }, [head, body]);
        head.addEventListener('click', function () { open[i] = !open[i]; card.classList.toggle('closed'); head.firstChild.textContent = open[i] ? '▾' : '▸'; });
        box.appendChild(card);
      });
      box.appendChild(el('button', { type: 'button', class: 'btn small add', text: '+ Add', onclick: function () {
        var blank = {};
        f.fields.forEach(function (x) { blank[x.name] = x.type === 'boolean' ? false : (x.type === 'object' ? {} : (x.list ? [] : '')); });
        arr.push(blank); open[arr.length - 1] = true; render(); changed();
      } }));
    }
    render();
    return box;
  }

  // ---------- Photos ----------

  var pickerDone = null;
  function openPicker(done) {
    pickerDone = done;
    var grid = $('picker-grid');
    grid.textContent = '';
    var file = el('input', { type: 'file', accept: 'image/*', hidden: true });
    file.addEventListener('change', function () { if (file.files[0]) addPhoto(file.files[0]); });
    grid.appendChild(el('button', { type: 'button', class: 'upload', onclick: function () { file.click(); } }, ['+ Upload a new photo']));
    grid.appendChild(file);
    var all = images.map(function (n) { return '/images/' + n; })
      .concat(Object.keys(pendingImages).filter(function (p) { return images.indexOf(p.split('/').pop()) === -1; }));
    all.forEach(function (path) {
      grid.appendChild(el('button', { type: 'button', onclick: function () { pick(path); } },
        [el('img', { src: imageSrc(path), alt: '', loading: 'lazy' }), el('span', { text: path.split('/').pop() })]));
    });
    $('picker').hidden = false;
  }
  function pick(path) {
    $('picker').hidden = true;
    if (pickerDone) pickerDone(path);
  }
  // Shrinks large photos to at most 2000px wide and saves them as JPEG.
  function addPhoto(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 2000 / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var dataUrl = c.toDataURL('image/jpeg', 0.85);
        var base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photo';
        var path = '/images/' + base + '.jpg', n = 2;
        while (images.indexOf(path.split('/').pop()) !== -1 || pendingImages[path]) path = '/images/' + base + '-' + (n++) + '.jpg';
        pendingImages[path] = { dataUrl: dataUrl, base64: dataUrl.split(',')[1] };
        pick(path);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ---------- Preview ----------

  function absolutise(html) {
    Object.keys(pendingImages).forEach(function (p) { html = html.split('"' + p + '"').join('"' + pendingImages[p].dataUrl + '"'); });
    return html.replace(/(["(])\/images\//g, '$1' + LIVE + '/images/');
  }

  // Keeps links inside the preview: page links switch the preview, outside links open a new tab.
  var PREVIEW_SCRIPT = "document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var h=a.getAttribute('href')||'';" +
    "if(h.charAt(0)==='#'){e.preventDefault();var t=document.getElementById(h.slice(1));if(t)t.scrollIntoView({behavior:'smooth'});else scrollTo({top:0,behavior:'smooth'});return;}" +
    "var m=/^(index\\.html|testimonials\\.html)(#.*)?$/.exec(h);if(m){e.preventDefault();parent.postMessage({editorPage:m[1],hash:(m[2]||'').slice(1)},'*');return;}" +
    "if(/^https?:/.test(h)){a.target='_blank';}});";

  var pendingAnchor = null, renderToken = 0;
  function renderPreview() {
    var mine = ++renderToken;
    return SiteRender.renderPage(templates, data, previewPage).then(function (html) {
      if (mine !== renderToken) return;
      var css = styles.replace(/url\("images\//g, 'url("' + LIVE + '/images/') +
        '\n.reveal{opacity:1!important;transform:none!important;transition:none!important}';
      html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>')
        .replace('<script src="script.js"></script>', '<script>' + script + '\n' + PREVIEW_SCRIPT + '</script>');
      html = absolutise(html);
      var frame = $('preview');
      var win = frame.contentWindow;
      var y = pendingAnchor === null && win ? win.scrollY : 0;
      frame.onload = function () {
        var w = frame.contentWindow;
        if (pendingAnchor !== null) {
          var t = pendingAnchor && w.document.getElementById(pendingAnchor);
          if (t && pendingAnchor !== 'top') w.scrollTo(0, t.getBoundingClientRect().top + w.scrollY - 70);
          else w.scrollTo(0, 0);
          pendingAnchor = null;
        } else w.scrollTo(0, y);
      };
      frame.srcdoc = html;
    }).catch(function (e) {
      console.error(e);
      flash('The preview could not be drawn: ' + e.message);
    });
  }

  function setPage(page, anchor) {
    previewPage = page;
    pendingAnchor = anchor || '';
    Array.prototype.forEach.call(document.querySelectorAll('#page-switch button'), function (b) { b.classList.toggle('on', b.dataset.page === page); });
    renderPreview();
  }

  // Desktop preview is drawn 1280px wide and scaled to fit; phone is drawn 390px wide.
  function fitPreview() {
    var stage = $('stage'), frame = $('preview');
    var w = stage.clientWidth, h = stage.clientHeight;
    stage.classList.toggle('phone', device === 'phone');
    if (device === 'phone') {
      var s = Math.min(1, (h - 24) / 844);
      frame.style.width = '390px';
      frame.style.height = ((h - 24) / s) + 'px';
      frame.style.transform = 'translateX(-50%) scale(' + s + ')';
      frame.style.transformOrigin = '50% 0';
    } else {
      var scale = Math.min(1, w / 1280);
      frame.style.width = (w / scale) + 'px';
      frame.style.height = (h / scale) + 'px';
      frame.style.transform = 'scale(' + scale + ')';
      frame.style.transformOrigin = '0 0';
    }
  }

  // ---------- Publishing ----------

  function publish() {
    var names = changedNames();
    if (!names.length) return;
    var btn = $('publish');
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    var head, baseTree;
    api('/git/ref/heads/' + BRANCH)
      .then(function (ref) {
        head = ref.object.sha;
        return api('/git/commits/' + head);
      })
      .then(function (commit) {
        baseTree = commit.tree.sha;
        // Warn if a section was saved somewhere else (e.g. Pages CMS) after the editor loaded it.
        return Promise.all(names.map(function (n) { return getFile(originals[n].path); }));
      })
      .then(function (latest) {
        var clash = names.filter(function (n, i) { return latest[i].sha !== originals[n].sha; }).map(labelFor);
        if (clash.length && !confirm('These sections were changed somewhere else since you opened the editor: ' + clash.join(', ') +
          '.\n\nPublish anyway? Your version will replace those changes.')) throw new Error('cancelled');
        var usedImages = Object.keys(pendingImages).filter(function (p) {
          return names.some(function (n) { return dump(data[n]).indexOf(p) !== -1; });
        });
        var blobs = names.map(function (n) {
          return api('/git/blobs', { method: 'POST', body: { content: dump(data[n]), encoding: 'utf-8' } })
            .then(function (b) { return { path: originals[n].path, mode: '100644', type: 'blob', sha: b.sha }; });
        }).concat(usedImages.map(function (p) {
          return api('/git/blobs', { method: 'POST', body: { content: pendingImages[p].base64, encoding: 'base64' } })
            .then(function (b) { return { path: p.slice(1), mode: '100644', type: 'blob', sha: b.sha }; });
        }));
        return Promise.all(blobs);
      })
      .then(function (tree) { return api('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: tree } }); })
      .then(function (tree) {
        return api('/git/commits', { method: 'POST', body: {
          message: 'Website editor: ' + names.map(labelFor).join(', '), tree: tree.sha, parents: [head] } });
      })
      .then(function (commit) { return api('/git/refs/heads/' + BRANCH, { method: 'PATCH', body: { sha: commit.sha } }); })
      .then(function () { return Promise.all(names.map(function (n) { return getFile(originals[n].path); })); })
      .then(function (fresh) {
        fresh.forEach(function (f, i) { originals[names[i]] = { path: f.path, sha: f.sha, text: f.text }; });
        Object.keys(pendingImages).forEach(function (p) {
          var n = p.split('/').pop();
          if (images.indexOf(n) === -1) images.push(n);
        });
        store(DRAFT_KEY, null);
        btn.textContent = 'Publish';
        updateStatus();
        flash('Published. It will be live on healingsanctuary.in in about a minute.');
      })
      .catch(function (e) {
        btn.textContent = 'Publish';
        updateStatus();
        if (e.message === 'cancelled') return;
        if (e.status === 401 || e.status === 403) flash('GitHub refused to save. The key may have expired or lacks "Contents: Read and write". Use ⋯ › Disconnect, then connect with a new key.');
        else flash('Publishing failed (' + e.message + '). Your changes are still here; try again in a minute.');
      });
  }

  function discard() {
    if (!confirm('Throw away all changes that are not published yet?')) return;
    Object.keys(originals).forEach(function (n) { data[n] = jsyaml.load(originals[n].text) || {}; });
    pendingImages = {};
    store(DRAFT_KEY, null);
    openSection(current);
    renderPreview();
    updateStatus();
  }

  // ---------- Connecting ----------

  function connect(t) {
    token = t;
    return api('').then(function (repo) {
      if (!repo.permissions || !repo.permissions.push) {
        var e = new Error('no write'); e.status = 403; throw e;
      }
    });
  }

  function showConnect(msg) {
    $('loading').hidden = true;
    $('app').hidden = true;
    $('connect').hidden = false;
    $('login-error').textContent = msg || '';
  }

  // ---------- Signing in ----------
  // login.json holds the GitHub key, locked with the email and password (PBKDF2 + AES-GCM).
  // Without the right pair it cannot be unlocked, so the page itself can stay public.

  function b64(bytes) { return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes))); }
  function unb64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }

  function loginKey(email, password, salt, iterations) {
    var secret = new TextEncoder().encode(email.trim().toLowerCase() + '\n' + password);
    return crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }

  // Used once to make login.json: SiteLogin.lock(email, password, githubKey)
  function lock(email, password, secret) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var iterations = 600000;
    return loginKey(email, password, salt, iterations).then(function (key) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(secret));
    }).then(function (data) {
      return { iterations: iterations, salt: b64(salt), iv: b64(iv), data: b64(data) };
    });
  }
  window.SiteLogin = { lock: lock };

  function unlock(email, password) {
    return fetch('login.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('Sign-in is not set up yet.');
      return r.json();
    }).then(function (box) {
      return loginKey(email, password, unb64(box.salt), box.iterations).then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
      }).then(function (plain) { return new TextDecoder().decode(plain); }, function () {
        var e = new Error('wrong'); e.wrong = true; throw e;
      });
    });
  }

  function start() {
    var saved = stored(TOKEN_KEY);
    // Local testing only: look around without a key (publishing will not work).
    if (!saved && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]look\b/.test(location.search)) return load().then(renderPreview);
    if (!saved) return showConnect();
    connect(saved).then(load).then(renderPreview).catch(function (e) {
      if (e.status === 401 || e.status === 403) { store(TOKEN_KEY, null); showConnect('Please sign in again.'); }
      else { $('loading').textContent = 'Could not reach GitHub (' + e.message + '). Check the internet connection and reload the page.'; }
    });
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var button = e.target.querySelector('button');
    button.disabled = true;
    $('login-error').textContent = 'Signing in…';
    unlock($('login-email').value, $('login-password').value).then(function (t) {
      return connect(t).then(function () {
        store(TOKEN_KEY, t);
        $('login-password').value = '';
        $('login-error').textContent = '';
        $('connect').hidden = true;
        return load().then(renderPreview);
      });
    }).catch(function (err) {
      token = null;
      $('login-error').textContent = err.wrong ? 'That email or password is not right.'
        : err.status === 401 || err.status === 403 ? 'Signing in worked, but GitHub no longer accepts the saved key. Use "Set up with a GitHub key" below.'
        : err.message;
    }).then(function () { button.disabled = false; });
  });

  $('token-link').href = 'https://github.com/settings/personal-access-tokens/new?name=Website+editor&description=Editor+for+healingsanctuary.in&target_name=' + OWNER + '&expires_in=none&contents=write';
  $('connect-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('token').value.trim();
    if (!t) return;
    $('connect-error').textContent = 'Checking…';
    connect(t).then(function () {
      store(TOKEN_KEY, t);
      $('connect').hidden = true;
      return load().then(renderPreview);
    }).catch(function (err) {
      token = null;
      $('connect-error').textContent = err.status === 401 ? 'GitHub did not accept that key. Check it was copied completely.'
        : err.status === 403 || err.status === 404 ? 'That key cannot change the website. Make sure it includes mahalakshmirajagopal.github.io and Contents: Read and write.'
        : 'Could not reach GitHub (' + err.message + ').';
    });
  });

  $('publish').addEventListener('click', publish);
  $('discard').addEventListener('click', discard);
  $('menu').addEventListener('click', function () { $('menu-pop').hidden = !$('menu-pop').hidden; });
  document.addEventListener('click', function (e) { if (!e.target.closest('.actions')) $('menu-pop').hidden = true; });
  $('reload').addEventListener('click', function () {
    $('menu-pop').hidden = true;
    if (changedNames().length && !confirm('Reload from the website? Unpublished changes are kept and put back on top.')) return;
    saveDraft();
    load().then(renderPreview);
  });
  $('signout').addEventListener('click', function () {
    store(TOKEN_KEY, null);
    location.reload();
  });
  $('picker-close').addEventListener('click', function () { $('picker').hidden = true; });
  $('picker').addEventListener('click', function (e) { if (e.target === $('picker')) $('picker').hidden = true; });
  Array.prototype.forEach.call(document.querySelectorAll('#page-switch button'), function (b) {
    b.addEventListener('click', function () { setPage(b.dataset.page, 'top'); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#device-switch button'), function (b) {
    b.addEventListener('click', function () {
      device = b.dataset.device;
      Array.prototype.forEach.call(document.querySelectorAll('#device-switch button'), function (x) { x.classList.toggle('on', x === b); });
      fitPreview();
      setPage(previewPage, previewPage === 'index.html' && current ? ANCHORS[nameOf(current)] || '' : 'top');
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.mobile-tabs button'), function (b) {
    b.addEventListener('click', function () {
      $('app').classList.toggle('show-preview', b.dataset.view === 'preview');
      Array.prototype.forEach.call(document.querySelectorAll('.mobile-tabs button'), function (x) { x.classList.toggle('on', x === b); });
      fitPreview();
    });
  });
  window.addEventListener('message', function (e) {
    if (e.source === $('preview').contentWindow && e.data && e.data.editorPage) setPage(e.data.editorPage, e.data.hash || 'top');
  });
  window.addEventListener('resize', fitPreview);
  window.addEventListener('beforeunload', function (e) {
    if (changedNames().length) { saveDraft(); e.preventDefault(); e.returnValue = ''; }
  });
  new ResizeObserver(fitPreview).observe($('stage'));

  start();
})();
