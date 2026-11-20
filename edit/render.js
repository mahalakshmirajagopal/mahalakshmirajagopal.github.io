// Renders the site's Jekyll pages in the browser, so the editor can preview
// unpublished changes. Covers what this site's templates use: front matter,
// one layout, includes with parameters, site.data and relative_url.
(function (root) {
  function splitFrontMatter(text) {
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!m) return { meta: {}, body: text };
    return { meta: root.jsyaml.load(m[1]) || {}, body: text.slice(m[0].length) };
  }

  // files: { "index.html": "...", "_includes/x.html": "...", "_layouts/default.html": "..." }
  function makeEngine(files) {
    var fs = {
      sep: '/',
      dirname: function (f) { return f.split('/').slice(0, -1).join('/'); },
      resolve: function (dir, file) { return (dir ? dir + '/' : '') + file; },
      contains: function () { return true; },
      exists: function (f) { return Promise.resolve(f in files); },
      existsSync: function (f) { return f in files; },
      readFile: function (f) { return Promise.resolve(files[f]); },
      readFileSync: function (f) { return files[f]; }
    };
    var engine = new root.liquidjs.Liquid({
      fs: fs, root: [''], partials: ['_includes'], layouts: ['_layouts'],
      extname: '', jekyllInclude: true, dynamicPartials: false, relativeReference: false
    });
    engine.registerFilter('relative_url', function (s) {
      if (!s) return s;
      return s.charAt(0) === '/' ? s : '/' + s;
    });
    return engine;
  }

  // Returns the finished HTML for one page, e.g. "index.html" or "testimonials.html".
  function renderPage(files, data, pagePath) {
    var engine = makeEngine(files);
    var page = splitFrontMatter(files[pagePath]);
    var pageVars = Object.assign({}, page.meta, { url: pagePath === 'index.html' ? '/' : '/' + pagePath, path: pagePath });
    var site = { data: data };
    return engine.parseAndRender(page.body, { site: site, page: pageVars }).then(function (content) {
      var layout = page.meta.layout && files['_layouts/' + page.meta.layout + '.html'];
      if (!layout) return content;
      return engine.parseAndRender(splitFrontMatter(layout).body, { site: site, page: pageVars, content: content });
    });
  }

  root.SiteRender = { renderPage: renderPage, splitFrontMatter: splitFrontMatter };
})(typeof window !== 'undefined' ? window : globalThis);
