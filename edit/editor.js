// Website editor for healingsanctuary.in.
// The page on the left is her real website, drawn in the browser from the site's own
// templates and _data files. Clicking words on it edits them in place. The panel on the
// right changes fonts, colours, photos and sections. Publish saves everything as one
// commit through the editor's server, which holds the GitHub key.
(function () {
  var BRANCH = 'main';
  var LIVE = 'https://healingsanctuary.in';
  var DRAFT_KEY = 'editor-draft';
  // The server that checks the password and holds the GitHub key (a local copy when testing on this Mac).
  var SERVER = location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://healing-editor.vault-voice.workers.dev';
  var SESSION_KEY = 'editor-session';

  // Where the page scrolls when a section's form is opened.
  var ANCHORS = { top: 'top', about: 'about', sessions: 'sessions', workshops: 'workshops', meditation: 'meditation', videos: 'videos', testimonials: 'testimonials', contact: 'contact' };
  // Text fields that feed links, phone numbers or messages; these are changed in the panel, not on the page.
  var NOT_ON_PAGE = /(link|url|youtube|_site$|channel|whatsapp|phone|email|subject|message|description|page_title)/i;
  // How the site looked originally, for "Back to the original look".
  var ORIGINAL = { colour_theme: 'Dawn', heading_font: 'Cormorant Garamond', body_font: 'Jost', text_size: 'Normal' };

  var schema = [];          // content entries from .pages.yml
  var templates = {};       // template files used by the renderer
  var styles = '', script = '';
  var data = {};            // every _data file, parsed: { name: value }
  var originals = {};       // editable files: { name: { path, sha, text } }
  var images = [];          // file names in /images
  var pendingImages = {};   // new photos not published yet: { "/images/x.jpg": { dataUrl, base64 } }
  var current = null;       // section whose form is open
  var previewPage = 'index.html';
  var device = 'desktop';
  var tokens = [];          // words shown on the page: index -> { file, path }

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k === 'style') n.setAttribute('style', attrs[k]);
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  function store(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) {} }
  function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function optName(v) { return v && typeof v === 'object' ? v.name : v; }
  function optLabel(v) { return v && typeof v === 'object' ? (v.label || v.name) : v; }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 4500);
  }

  // ---------- Server ----------

  function api(path, opts) {
    opts = opts || {};
    var headers = authHeaders({ Accept: 'application/json' });
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(SERVER + '/api/gh' + path, {
      method: opts.method || 'GET', headers: headers, cache: 'no-store',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) { store(SESSION_KEY, null); showSignin('Please sign in again.'); var e0 = new Error('signed out'); e0.status = 401; throw e0; }
      if (!r.ok) { var err = new Error('the server replied ' + r.status); err.status = r.status; throw err; }
      return r.status === 204 ? null : r.json();
    });
  }
  function authHeaders(h) {
    h = h || {};
    h['x-editor'] = '1';
    var t = stored(SESSION_KEY);
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
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
    return api('/contents/' + encodeURI(path) + '?ref=' + BRANCH).catch(function (e) { if (e.status === 401) throw e; return []; });
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
        loadFontPreviews();
        restoreDraft();
        buildLook();
        buildSectionList();
        if (current) openSection(entryByName(nameOf(current)) || null, true);
        updateStatus();
        $('loading').hidden = true;
        $('signin').hidden = true;
        $('app').hidden = false;
        fitPreview();
      });
  }

  function nameOf(entry) { return entry.path.split('/').pop().replace(/\.ya?ml$/, ''); }
  function entryByName(n) { return schema.filter(function (s) { return nameOf(s) === n; })[0]; }
  function labelFor(name) {
    var e = entryByName(name);
    return e ? e.label.replace(/\s*\(.*\)$/, '') : name;
  }

  // Loads every font on offer, so the font buttons show what each one looks like.
  var fontsLoaded = false;
  function loadFontPreviews() {
    if (fontsLoaded || !data.fonts) return;
    fontsLoaded = true;
    var specs = Object.keys(data.fonts).map(function (f) { return 'family=' + data.fonts[f].spec; });
    for (var i = 0; i < specs.length; i += 8) {
      document.head.appendChild(el('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?' + specs.slice(i, i + 8).join('&') + '&display=swap' }));
    }
  }

  // ---------- Changes and drafts ----------

  function dump(value) { return jsyaml.dump(value, { lineWidth: -1, noRefs: true, quotingType: '"' }); }
  function editableNames() { return schema.map(nameOf).filter(function (n) { return originals[n]; }); }
  function changedNames() {
    return editableNames().filter(function (n) { return dump(data[n]) !== dump(jsyaml.load(originals[n].text) || {}); });
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
      if (stale.length) toast('Some changes from last time were left out, because those parts were changed somewhere else since.', 7000);
      else if (Object.keys(draft.files).length) toast('Your unpublished changes from last time are back.');
    } catch (e) { store(DRAFT_KEY, null); }
  }

  function updateStatus() {
    var changed = changedNames();
    var s = $('status');
    s.textContent = changed.length ? 'Not published yet: ' + changed.map(labelFor).join(', ') : 'Everything is published';
    s.className = 'status' + (changed.length ? ' dirty' : '');
    $('publish').disabled = !changed.length;
    $('discard').disabled = !changed.length;
    $('undo2').disabled = !changed.length;
    each('.section-list button', function (b) {
      var c = b.querySelector('.changed');
      if (c) c.hidden = changed.indexOf(b.dataset.name) === -1;
    });
  }

  var changeTimer;
  function changed(noRedraw) {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(function () { saveDraft(); updateStatus(); if (!noRedraw) renderPreview(); }, noRedraw ? 400 : 200);
  }

  // ---------- Fonts & colours tab ----------

  function themeColour(name) {
    var t = data.themes && data.themes[(data.theme || {}).colour_theme] || (data.themes || {}).Dawn || {};
    var own = (data.theme || {}).colours || {};
    var key = { accent: 'accent', highlight: 'highlight' }[name];
    if (!key) return null;
    return /^#[0-9a-f]{6}$/i.test(own[key] || '') ? own[key] : t[key];
  }
  function swatchValue(name) {
    var v = (data.colour_names || {})[name];
    if (!v) return null;
    return /^var\(/.test(v) ? themeColour(name) : v;
  }
  function textStyleEntry() { return entryByName('text_style'); }

  function buildLook() {
    var box = $('tab-look');
    var keep = box.scrollTop;
    box.textContent = '';
    var th = data.theme || (data.theme = {});
    var ts = data.text_style || (data.text_style = {});
    var fontNames = Object.keys(data.fonts || {});

    // Colour theme
    box.appendChild(el('h3', { text: 'Colour theme' }));
    box.appendChild(el('p', { class: 'note', text: 'The background and main colours of the whole website.' }));
    var themes = el('div', { class: 'themes' });
    Object.keys(data.themes || {}).forEach(function (name) {
      var t = data.themes[name];
      themes.appendChild(el('button', { type: 'button', class: 'theme' + (th.colour_theme === name ? ' on' : ''), onclick: function () {
        th.colour_theme = name; changed(); buildLook();
      } }, [el('div', { class: 'strip' }, [t.background, t.background_soft, t.text, t.accent, t.highlight].map(function (c) { return el('i', { style: 'background:' + c }); })),
        el('span', { text: name })]));
    });
    box.appendChild(themes);

    // Main fonts
    function fontGrid(current, onPick, withNormal, normalText) {
      var g = el('div', { class: 'fonts' });
      if (withNormal) g.appendChild(el('button', { type: 'button', class: 'font normal' + (!current || current === 'normal' ? ' on' : ''), onclick: function () { onPick('normal'); } },
        [el('b', { text: 'Normal' }), el('small', { text: normalText })]));
      fontNames.forEach(function (f) {
        g.appendChild(el('button', { type: 'button', class: 'font' + (current === f ? ' on' : ''), onclick: function () { onPick(f); } },
          [el('b', { text: 'Aa Healing', style: 'font-family:"' + f + '",' + data.fonts[f].fallback }), el('small', { text: f })]));
      });
      return g;
    }
    box.appendChild(el('h3', { text: 'Font for headings' }));
    box.appendChild(fontGrid(ts.heading_font || ORIGINAL.heading_font, function (f) { ts.heading_font = f; changed(); buildLook(); }));
    box.appendChild(el('h3', { text: 'Font for everything else' }));
    box.appendChild(fontGrid(ts.body_font || ORIGINAL.body_font, function (f) { ts.body_font = f; changed(); buildLook(); }));

    box.appendChild(el('h3', { text: 'Text size' }));
    var sizes = el('div', { class: 'sizes' });
    ['Smaller', 'Normal', 'Larger', 'Largest'].forEach(function (s) {
      sizes.appendChild(el('button', { type: 'button', class: (ts.text_size || 'Normal') === s ? 'on' : '', text: s, onclick: function () { ts.text_size = s; changed(); buildLook(); } }));
    });
    box.appendChild(sizes);

    // Each kind of text
    box.appendChild(el('h3', { text: 'Each kind of text' }));
    box.appendChild(el('p', { class: 'note', text: 'Open one to give it its own font or colour. Normal keeps the main font and the theme’s colour.' }));
    var parts = el('div', { class: 'parts' });
    var entry = textStyleEntry();
    var colourOpts = [];
    (entry ? entry.fields : []).forEach(function (f) {
      if (f.type !== 'object') return;
      var colourField = f.fields.filter(function (x) { return x.name === 'colour'; })[0];
      if (!colourOpts.length && colourField) colourOpts = colourField.options.values;
      var v = ts[f.name] || (ts[f.name] = { font: 'normal', colour: 'normal' });
      var isOpen = openParts[f.name];
      var c = swatchValue(v.colour);
      var now = el('span', { class: 'now' }, [
        c ? el('span', { class: 'dot', style: 'background:' + c }) : null,
        ' ' + (v.font && v.font !== 'normal' ? v.font : '')
      ]);
      var body = el('div', { class: 'part-body', hidden: !isOpen });
      var role = /Normal keeps the main font for headings/.test((f.fields[0] || {}).description || '') ? 'headings' : 'everything else';
      body.appendChild(el('div', { class: 'label', text: 'Font' }));
      body.appendChild(fontGrid(v.font, function (fnt) { v.font = fnt; changed(); buildLook(); }, true, 'same as ' + role));
      body.appendChild(el('div', { class: 'label', text: 'Colour' }));
      var sw = el('div', { class: 'swatches' });
      var nameLine = el('p', { class: 'swatch-name', text: optLabel(colourOpts.filter(function (o) { return optName(o) === v.colour; })[0] || '') });
      colourOpts.forEach(function (o) {
        var n = optName(o), val = swatchValue(n);
        sw.appendChild(el('button', { type: 'button', class: 'sw' + (n === 'normal' ? ' normal' : '') + ((v.colour || 'normal') === n ? ' on' : ''),
          style: val ? 'background:' + val : '', title: optLabel(o), 'aria-label': optLabel(o),
          onmouseenter: function () { nameLine.textContent = optLabel(o); },
          onclick: function () { v.colour = n; changed(); buildLook(); } }));
      });
      body.appendChild(sw);
      body.appendChild(nameLine);
      var head = el('button', { type: 'button', class: 'part-head', onclick: function () { openParts[f.name] = !openParts[f.name]; buildLook(); } },
        [el('span', { class: 'name', text: f.label }), now, el('span', { class: 'caret', text: isOpen ? '▾' : '▸' })]);
      parts.appendChild(el('div', { class: 'part' + (isOpen ? ' open' : '') }, [head, body]));
    });
    box.appendChild(parts);

    // Background photos and own colours stay in Sections & photos (Look and feel).
    box.appendChild(el('div', { class: 'reset' }, [
      el('p', { class: 'note', text: 'Background colours and photos are under Sections & photos › Look and feel.' }),
      el('button', { type: 'button', class: 'btn', text: 'Back to the original look', onclick: function () {
        if (!confirm('Put all fonts and colours back to how the website first looked? Your words and photos stay as they are.')) return;
        th.colour_theme = ORIGINAL.colour_theme;
        Object.keys(th.colours || {}).forEach(function (k) { th.colours[k] = ''; });
        ts.heading_font = ORIGINAL.heading_font; ts.body_font = ORIGINAL.body_font; ts.text_size = ORIGINAL.text_size;
        Object.keys(ts).forEach(function (k) { if (ts[k] && typeof ts[k] === 'object') { ts[k].font = 'normal'; ts[k].colour = 'normal'; } });
        changed(); buildLook();
        toast('Fonts and colours are back to the original. Press Publish to put this live.');
      } })
    ]));
    box.scrollTop = keep;
  }
  var openParts = {};

  // ---------- Sections & photos tab ----------

  function buildSectionList() {
    var list = $('section-list');
    list.textContent = '';
    schema.forEach(function (entry) {
      if (nameOf(entry) === 'text_style') return;     // has its own tab
      list.appendChild(el('button', { type: 'button', 'data-name': nameOf(entry), onclick: function () { openSection(entry); } },
        [el('span', { text: entry.label.replace(/\s*\(.*\)$/, '') }), el('span', { class: 'changed', text: 'changed', hidden: true })]));
    });
  }

  function openSection(entry, keepPlace) {
    current = entry;
    if (!entry) { $('section-form').hidden = true; $('section-list').hidden = false; return; }
    var name = nameOf(entry);
    $('section-list').hidden = true;
    $('section-form').hidden = false;
    $('section-title').textContent = entry.label;
    var form = $('form');
    form.textContent = '';
    if (!data[name]) data[name] = {};
    entry.fields.forEach(function (f) { form.appendChild(fieldFor(f, data[name], [name])); });
    if (!keepPlace) {
      $('tab-sections').scrollTop = 0;
      if (ANCHORS[name]) setPage('index.html', ANCHORS[name]);
      else if (name === 'testimonials') setPage('testimonials.html', 'top');
    }
  }
  function refreshForm() { if (current && !$('section-form').hidden) openSection(current, true); }

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
    if (f.description && !(path[0] === 'theme' && path[1] === 'colours')) wrap.appendChild(el('p', { class: 'hint', text: f.description }));
    if (f.type === 'object') {
      if (!obj[f.name] || typeof obj[f.name] !== 'object') obj[f.name] = {};
      var group = el('div', { class: 'group' });
      if (path[0] === 'theme' && f.name === 'colours') group.appendChild(el('p', { class: 'hint', text: 'Pick a colour with the square, or press "Use theme colour" to go back to the colour theme’s own.' }));
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
        var o = el('option', { value: optName(v), text: optLabel(v) });
        if (String(optName(v)) === String(value)) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { obj[key] = sel.value; changed(); if (path[0] === 'theme') buildLook(); });
      return sel;
    }
    if (f.type === 'text' || f.type === 'rich-text') {
      var ta = el('textarea', { id: id, rows: Math.min(10, Math.max(3, Math.ceil(String(value).length / 45))) });
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

  function themeDefault(key) {
    var t = data.themes && data.theme && data.themes[data.theme.colour_theme];
    return (t && t[key]) || '';
  }
  function colourInput(obj, key, id) {
    var row = el('div', { class: 'colour' });
    var picker = el('input', { type: 'color', id: id, 'aria-label': 'Pick a colour' });
    var label = el('span', { class: 'hint' });
    var clear = el('button', { type: 'button', class: 'btn small', text: 'Use theme colour' });
    function sync() {
      var own = /^#[0-9a-f]{6}$/i.test(obj[key] || '');
      picker.value = own ? obj[key] : (themeDefault(key) || '#ffffff');
      label.textContent = own ? 'Your own colour' : 'From the colour theme';
      clear.hidden = !own;
    }
    picker.addEventListener('input', function () { obj[key] = picker.value; sync(); changed(); });
    clear.addEventListener('click', function () { obj[key] = ''; sync(); changed(); });
    sync();
    row.appendChild(picker); row.appendChild(label); row.appendChild(clear);
    return row;
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
        if (!confirm('Remove this one?')) return;
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
  function pick(path) { $('picker').hidden = true; if (pickerDone) pickerDone(path); }
  // Shrinks large photos to at most 2000px and saves them as JPEG.
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

  // ---------- Words on the page ----------
  // Each text value is swapped for a marker before drawing; afterwards each marker in the
  // page text becomes an editable <x-ed> (its own tag, so no site CSS for span applies to it), and markers inside tags get their plain text back.

  var OPEN = '⟦', CLOSE = '⟧';
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function markedData() {
    tokens = [];
    var copy = clone(data);
    function mark(fields, obj, file, path) {
      if (!obj || typeof obj !== 'object') return;
      fields.forEach(function (f) {
        var v = obj[f.name], p = path.concat(f.name);
        if (f.list && Array.isArray(v)) {
          v.forEach(function (item, i) {
            if (f.type === 'object') mark(f.fields, item, file, p.concat(i));
            else if ((f.type === 'string' || f.type === 'text') && typeof item === 'string' && item.trim() && !NOT_ON_PAGE.test(f.name)) {
              tokens.push({ file: file, path: p.concat(i) }); v[i] = OPEN + (tokens.length - 1) + CLOSE;
            }
          });
        } else if (f.type === 'object') {
          mark(f.fields, v, file, p);
        } else if ((f.type === 'string' || f.type === 'text') && typeof v === 'string' && v.trim() && !NOT_ON_PAGE.test(f.name)) {
          tokens.push({ file: file, path: p }); obj[f.name] = OPEN + (tokens.length - 1) + CLOSE;
        }
      });
    }
    schema.forEach(function (entry) { var n = nameOf(entry); mark(entry.fields, copy[n], n, []); });
    return copy;
  }
  function valueAt(t) {
    var o = data[t.file];
    t.path.forEach(function (k) { o = o == null ? o : o[k]; });
    return o == null ? '' : String(o);
  }
  function setValueAt(t, v) {
    var o = data[t.file];
    for (var i = 0; i < t.path.length - 1; i++) o = o[t.path[i]];
    o[t.path[t.path.length - 1]] = v;
  }
  // Words can carry colour tags: "Awaken [colour=plum]inner light[/colour]".
  var TAG = /\[colour=([^\]]*)\]([\s\S]*?)\[\/colour\]/g;
  function plainOf(v) { return String(v).replace(TAG, '$2').replace(/\[\/?colour[^\]]*\]/g, ''); }
  function colourCss(name) {
    var v = (data.colour_names || {})[name];
    return v || '';
  }
  function taggedHtml(v) {
    var out = '', last = 0, m;
    v = String(v);
    TAG.lastIndex = 0;
    while ((m = TAG.exec(v))) {
      out += esc(v.slice(last, m.index));
      var css = colourCss(m[1]);
      out += '<span data-c="' + esc(m[1]) + '"' + (css ? ' style="color:' + esc(css) + '"' : '') + '>' + esc(m[2]) + '</span>';
      last = TAG.lastIndex;
    }
    return out + esc(v.slice(last));
  }
  function unmark(html) {
    var re = new RegExp(OPEN + '(\\d+)' + CLOSE, 'g');
    var raw = false;
    return html.split(/(<[^>]*>)/).map(function (piece) {
      if (piece.charAt(0) === '<') {
        if (/^<(script|style|title|textarea)\b/i.test(piece)) raw = true;
        else if (/^<\/(script|style|title|textarea)/i.test(piece)) raw = false;
        return piece.replace(re, function (m, i) { return esc(plainOf(valueAt(tokens[i]))); });
      }
      return piece.replace(re, function (m, i) {
        return raw ? esc(plainOf(valueAt(tokens[i]))) : '<x-ed data-ed="' + i + '">' + taggedHtml(valueAt(tokens[i])) + '</x-ed>';
      });
    }).join('');
  }

  // The colours offered when words are selected (same list and names as the Fonts & colours tab).
  function palette() {
    var entry = textStyleEntry(), opts = [];
    (entry ? entry.fields : []).some(function (f) {
      var c = f.type === 'object' && f.fields.filter(function (x) { return x.name === 'colour'; })[0];
      if (c) { opts = c.options.values; return true; }
      return false;
    });
    return opts.map(function (o) { var n = optName(o); return { n: n, label: optLabel(o), css: n === 'normal' ? '' : colourCss(n), show: n === 'normal' ? '#ffffff' : (swatchValue(n) || '#ccc') }; });
  }

  // Runs inside the page: click words to edit them, select words to colour them, keep links inside the editor.
  function pageScript(PAL) {
    var css = document.createElement('style');
    css.textContent = 'x-ed{border-radius:3px;cursor:text;transition:background .15s,box-shadow .15s}' +
      'x-ed:hover{background:rgba(123,94,167,.13);box-shadow:0 0 0 2px rgba(123,94,167,.45)}' +
      'x-ed[contenteditable]{background:rgba(123,94,167,.12);box-shadow:0 0 0 2px #7b5ea7;outline:none}' +
      'x-ed:empty{display:inline-block;min-width:2em;min-height:1em}' +
      'x-bar{position:fixed;z-index:99999;display:none;gap:5px;align-items:center;background:#fff;border:1px solid #e4dccf;border-radius:999px;padding:6px 8px;box-shadow:0 10px 30px -10px rgba(0,0,0,.35);font:500 12px/1 system-ui,sans-serif;color:#2d3047}' +
      'x-bar b{margin:0 4px 0 2px;font-weight:600;white-space:nowrap}' +
      'x-bar i{display:block;width:22px;height:22px;border-radius:50%;border:1px solid rgba(0,0,0,.15);cursor:pointer;position:relative;flex:none}' +
      'x-bar i:hover{transform:scale(1.15)}' +
      'x-bar i.normal::after{content:"";position:absolute;left:3px;right:3px;top:50%;height:2px;background:#b9b2a6;transform:rotate(-45deg)}';
    document.head.appendChild(css);
    var byName = {}, byRgb = {};
    function rgbOf(v) {   // the colour a value really shows as, e.g. "rgb(107, 62, 138)"
      var probe = document.createElement('i');
      probe.style.color = v;
      document.body.appendChild(probe);
      var c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }
    PAL.forEach(function (p) { byName[p.n] = p; if (p.css) byRgb[rgbOf(p.css)] = p.n; });
    // Chrome sometimes keeps a colour by writing its own <font color> or style; map it back to our name.
    function colourOfEl(k, c) {
      if (k.hasAttribute('data-c')) return k.getAttribute('data-c') || null;
      var v = k.getAttribute('color') || (k.style && k.style.color);
      if (v) { var n = byRgb[rgbOf(v)]; if (n) return n; }
      return c;
    }
    function send(m) { parent.postMessage(m, '*'); }
    function edOf(n) { n = n && (n.nodeType === 1 ? n : n.parentNode); return n && n.closest ? n.closest('x-ed') : null; }

    // ---- text with colours <-> runs ----
    function runsOf(t) {
      var chars = [];
      (function walk(node, c) {
        node.childNodes.forEach(function (k) {
          if (k.nodeType === 3) { for (var i = 0; i < k.data.length; i++) chars.push({ ch: k.data[i], c: c }); }
          else if (k.nodeType === 1) {
            if (k.tagName === 'BR') { chars.push({ ch: ' ', c: c }); return; }
            var nc = colourOfEl(k, c);
            walk(k, nc);
          }
        });
      })(t, null);
      return chars;
    }
    function toRuns(chars) {
      var runs = [];
      chars.forEach(function (x) {
        var ch = /\s/.test(x.ch) ? ' ' : x.ch;
        var last = runs[runs.length - 1];
        if (last && last.c === x.c) last.text += ch; else runs.push({ text: ch, c: x.c });
      });
      return runs;
    }
    function serial(runs) {
      return runs.map(function (r) { return r.c && r.c !== 'normal' ? '[colour=' + r.c + ']' + r.text + '[/colour]' : r.text; }).join('');
    }
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function html(runs) {
      return runs.map(function (r) {
        if (!r.c || r.c === 'normal') return esc(r.text);
        var p = byName[r.c];
        return '<span data-c="' + r.c + '"' + (p && p.css ? ' style="color:' + p.css + '"' : '') + '>' + esc(r.text) + '</span>';
      }).join('');
    }
    function report(t) {
      var runs = toRuns(runsOf(t));
      var h = html(runs);
      document.querySelectorAll('x-ed[data-ed="' + t.dataset.ed + '"]').forEach(function (o) { if (o !== t) o.innerHTML = h; });
      send({ edText: t.dataset.ed, text: serial(runs) });
    }

    // ---- colour bar for selected words ----
    var bar = document.createElement('x-bar');
    bar.appendChild(Object.assign(document.createElement('b'), { textContent: 'Colour' }));
    PAL.forEach(function (p) {
      var i = document.createElement('i');
      if (p.n === 'normal') i.className = 'normal'; else i.style.background = p.show;
      i.title = p.label;
      i.addEventListener('mousedown', function (e) { e.preventDefault(); applyColour(p.n); });
      bar.appendChild(i);
    });
    document.body.appendChild(bar);
    function offsets(t, r) {
      var pre = document.createRange();
      pre.selectNodeContents(t); pre.setEnd(r.startContainer, r.startOffset);
      var s = pre.toString().length;
      return [s, s + r.toString().length];
    }
    function select(t, s, e) {
      var walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT), n, pos = 0, r = document.createRange(), started = false;
      while ((n = walker.nextNode())) {
        var len = n.data.length;
        if (!started && s <= pos + len) { r.setStart(n, s - pos); started = true; }
        if (started && e <= pos + len) { r.setEnd(n, e - pos); break; }
        pos += len;
      }
      var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
    function applyColour(name) {
      var sel = getSelection();
      if (!sel.rangeCount) return;
      var r = sel.getRangeAt(0), t = edOf(r.commonAncestorContainer);
      if (!t || !t.isContentEditable) return;
      var o = offsets(t, r), chars = runsOf(t);
      for (var i = o[0]; i < o[1] && i < chars.length; i++) chars[i].c = name === 'normal' ? null : name;
      t.innerHTML = html(toRuns(chars));
      select(t, o[0], o[1]);
      report(t);
    }
    document.addEventListener('selectionchange', function () {
      var sel = getSelection();
      var t = sel.rangeCount && !sel.isCollapsed ? edOf(sel.getRangeAt(0).commonAncestorContainer) : null;
      if (!t || !t.isContentEditable) { bar.style.display = 'none'; return; }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      bar.style.display = 'flex';
      var w = bar.offsetWidth, h = bar.offsetHeight;
      bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + 'px';
      bar.style.top = (rect.top > h + 14 ? rect.top - h - 10 : rect.bottom + 10) + 'px';
    });

    // ---- clicking, typing, links ----
    function caret(x, y) {
      var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      if (!r && document.caretPositionFromPoint) { var p = document.caretPositionFromPoint(x, y); if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); } }
      if (r) { var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest('x-bar')) return;
      var t = e.target.closest('x-ed');
      if (t) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (t.isContentEditable) return;
        t.contentEditable = 'true'; t.spellcheck = true; t.focus(); caret(e.clientX, e.clientY);
        send({ edFocus: t.dataset.ed });
        return;
      }
      var a = e.target.closest('a');
      if (!a) return;
      var h = a.getAttribute('href') || '';
      if (h.charAt(0) === '#') { e.preventDefault(); var g = document.getElementById(h.slice(1)); if (g) g.scrollIntoView({ behavior: 'smooth' }); else scrollTo({ top: 0, behavior: 'smooth' }); return; }
      var m = /^(index\.html|testimonials\.html)(#.*)?$/.exec(h);
      if (m) { e.preventDefault(); send({ editorPage: m[1], hash: (m[2] || '').slice(1) }); return; }
      e.preventDefault();
      if (/^https?:/.test(h)) window.open(h, '_blank', 'noopener');
    }, true);
    document.addEventListener('input', function (e) {
      var t = edOf(e.target);
      if (!t) return;
      if (t.querySelector('font, [style]:not([data-c]), b, i, u, div, br')) {   // browser added its own tags: redraw cleanly, keep the caret
        var sel = getSelection(), at = null;
        if (sel.rangeCount) at = offsets(t, sel.getRangeAt(0))[1];
        t.innerHTML = html(toRuns(runsOf(t)));
        if (at !== null) select(t, at, at);
      }
      report(t);
    });
    document.addEventListener('keydown', function (e) {
      var t = edOf(e.target);
      if (!t) return;
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); t.blur(); }
      if ((e.metaKey || e.ctrlKey) && /^[biu]$/i.test(e.key)) e.preventDefault();    // no bold/italic here
    });
    document.addEventListener('paste', function (e) {
      var t = edOf(e.target);
      if (!t) return;
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text').replace(/\s*\n\s*/g, ' '));
    });
    document.addEventListener('drop', function (e) { if (edOf(e.target)) e.preventDefault(); }, true);
    document.addEventListener('focusout', function (e) {
      var t = edOf(e.target);
      if (!t || e.target !== t) return;
      t.removeAttribute('contenteditable');
      bar.style.display = 'none';
      send({ edDone: t.dataset.ed });
    });
    document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
  }

  function absolutise(html) {
    Object.keys(pendingImages).forEach(function (p) { html = html.split('"' + p + '"').join('"' + pendingImages[p].dataUrl + '"'); });
    return html.replace(/(["(])\/images\//g, '$1' + LIVE + '/images/');
  }

  var pendingAnchor = null, renderToken = 0, editing = false;
  function renderPreview() {
    if (editing) return Promise.resolve();       // never redraw under her cursor
    var mine = ++renderToken;
    return SiteRender.renderPage(templates, markedData(), previewPage).then(function (html) {
      if (mine !== renderToken) return;
      html = unmark(html);
      var css = styles.replace(/url\("images\//g, 'url("' + LIVE + '/images/') +
        '\n.reveal{opacity:1!important;transform:none!important;transition:none!important}';
      html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>')
        .replace('<script src="script.js"></script>', '<script>' + script + '\n(' + pageScript.toString() + ')(' + JSON.stringify(palette()).replace(/</g, '\\u003c') + ');</script>');
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
      toast('The page could not be drawn: ' + e.message, 8000);
    });
  }

  function setPage(page, anchor) {
    previewPage = page;
    pendingAnchor = anchor || '';
    each('#page-switch button', function (b) { b.classList.toggle('on', b.dataset.page === page); });
    renderPreview();
  }

  // Computer view is drawn 1280px wide and scaled to fit; phone view is 390px wide.
  function fitPreview() {
    var stage = $('stage'), frame = $('preview');
    var w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    var small = window.innerWidth <= 900;
    stage.classList.toggle('phone', device === 'phone' && !small);
    if (small) {
      frame.style.width = w + 'px'; frame.style.height = h + 'px'; frame.style.transform = 'none';
    } else if (device === 'phone') {
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
      .then(function (ref) { head = ref.object.sha; return api('/git/commits/' + head); })
      .then(function (commit) {
        baseTree = commit.tree.sha;
        return Promise.all(names.map(function (n) { return getFile(originals[n].path); }));
      })
      .then(function (latest) {
        var clash = names.filter(function (n, i) { return latest[i].sha !== originals[n].sha; }).map(labelFor);
        if (clash.length && !confirm('These parts were changed somewhere else since you opened the editor: ' + clash.join(', ') +
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
        return api('/git/commits', { method: 'POST', body: { message: 'Website editor: ' + names.map(labelFor).join(', '), tree: tree.sha, parents: [head] } });
      })
      .then(function (commit) { return api('/git/refs/heads/' + BRANCH, { method: 'PATCH', body: { sha: commit.sha } }); })
      .then(function () { return Promise.all(names.map(function (n) { return getFile(originals[n].path); })); })
      .then(function (fresh) {
        fresh.forEach(function (f, i) { originals[names[i]] = { path: f.path, sha: f.sha, text: f.text }; });
        Object.keys(pendingImages).forEach(function (p) { var n = p.split('/').pop(); if (images.indexOf(n) === -1) images.push(n); });
        store(DRAFT_KEY, null);
        btn.textContent = 'Publish';
        updateStatus();
        toast('Published! It will be on healingsanctuary.in in about a minute.', 7000);
      })
      .catch(function (e) {
        btn.textContent = 'Publish';
        updateStatus();
        if (e.message === 'cancelled' || e.status === 401) return;
        toast('Publishing did not work (' + e.message + '). Your changes are still here; please try again in a minute.', 9000);
      });
  }

  function discard() {
    if (!confirm('Undo every change that is not published yet?')) return;
    Object.keys(originals).forEach(function (n) { data[n] = jsyaml.load(originals[n].text) || {}; });
    pendingImages = {};
    store(DRAFT_KEY, null);
    buildLook(); refreshForm(); renderPreview(); updateStatus();
  }

  // ---------- Signing in ----------

  function showSignin(msg) {
    $('loading').hidden = true;
    $('app').hidden = true;
    $('signin').hidden = false;
    $('login-error').textContent = msg || '';
    setTimeout(function () { $('login-email').focus(); }, 50);
  }

  function start() {
    fetch(SERVER + '/api/me', { cache: 'no-store', headers: authHeaders() }).then(function (r) {
      if (r.status === 401) { store(SESSION_KEY, null); return showSignin(); }
      if (!r.ok) throw new Error('the server replied ' + r.status);
      return load().then(renderPreview);
    }).catch(function (e) {
      $('loading').textContent = 'Could not open the editor (' + e.message + '). Check the internet connection and reload the page.';
    });
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var button = e.target.querySelector('button');
    button.disabled = true;
    $('login-error').textContent = 'Signing in…';
    fetch(SERVER + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-editor': '1' },
      body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value }) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'Signing in did not work.');
        store(SESSION_KEY, res.body.token);
        $('login-password').value = '';
        $('login-error').textContent = '';
        return load().then(renderPreview);
      })
      .catch(function (err) { $('login-error').textContent = err.message; })
      .then(function () { button.disabled = false; });
  });

  // ---------- Buttons ----------

  $('publish').addEventListener('click', publish);
  $('discard').addEventListener('click', discard);
  $('undo2').addEventListener('click', function () { $('menu-pop').hidden = true; discard(); });
  $('menu').addEventListener('click', function () { $('menu-pop').hidden = !$('menu-pop').hidden; });
  document.addEventListener('click', function (e) { if (!e.target.closest('.actions')) $('menu-pop').hidden = true; });
  $('reload').addEventListener('click', function () {
    $('menu-pop').hidden = true;
    saveDraft();
    load().then(renderPreview);
  });
  $('signout').addEventListener('click', function () {
    saveDraft();
    store(SESSION_KEY, null);
    location.reload();
  });
  $('back').addEventListener('click', function () { openSection(null); });
  $('picker-close').addEventListener('click', function () { $('picker').hidden = true; });
  $('picker').addEventListener('click', function (e) { if (e.target === $('picker')) $('picker').hidden = true; });
  each('.tabs button', function (b) {
    b.addEventListener('click', function () {
      each('.tabs button', function (x) { x.classList.toggle('on', x === b); });
      $('tab-look').hidden = b.dataset.tab !== 'look';
      $('tab-sections').hidden = b.dataset.tab !== 'sections';
    });
  });
  each('#page-switch button', function (b) { b.addEventListener('click', function () { setPage(b.dataset.page, 'top'); }); });
  each('#device-switch button', function (b) {
    b.addEventListener('click', function () {
      device = b.dataset.device;
      each('#device-switch button', function (x) { x.classList.toggle('on', x === b); });
      fitPreview();
      setPage(previewPage, 'top');
    });
  });
  each('.mobile-tabs button', function (b) {
    b.addEventListener('click', function () {
      $('app').classList.toggle('show-panel', b.dataset.view === 'panel');
      each('.mobile-tabs button', function (x) { x.classList.toggle('on', x === b); });
      fitPreview();
    });
  });
  window.addEventListener('message', function (e) {
    if (e.source !== $('preview').contentWindow || !e.data) return;
    var m = e.data;
    if (m.editorPage) setPage(m.editorPage, m.hash || 'top');
    else if (m.edFocus != null) editing = true;
    else if (m.edText != null && tokens[m.edText]) { setValueAt(tokens[m.edText], m.text); changed(true); }
    else if (m.edDone != null) { editing = false; refreshForm(); }
  });
  window.addEventListener('resize', fitPreview);
  window.addEventListener('beforeunload', function (e) {
    if (changedNames().length) { saveDraft(); e.preventDefault(); e.returnValue = ''; }
  });
  new ResizeObserver(fitPreview).observe($('stage'));

  start();
})();
