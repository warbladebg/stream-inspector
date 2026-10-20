// Isolated-world content script: inject.js runs in the page's MAIN world and
// can't use chrome.* APIs, so this relays the settings to it and handles the
// keyboard shortcuts.
(() => {
  const { DEFAULTS, clampScale, comboFromEvent, isEditable, withDefaults } = self.StreamInspectorShared;
  let cfg = null;
  const send = () => {
    if (cfg) document.dispatchEvent(new CustomEvent('__stream_inspector_cfg', { detail: JSON.stringify(cfg) }));
  };

  chrome.storage.local.get(DEFAULTS).then(v => { cfg = withDefaults(v); send(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !cfg) return;
    const next = { ...cfg };
    for (const k of Object.keys(DEFAULTS)) if (changes[k]) next[k] = changes[k].newValue;
    cfg = withDefaults(next);
    send();
  });
  // inject.js may start after us; it announces itself and we answer.
  document.addEventListener('__stream_inspector_ready', send);

  // Registered at document_start in the capture phase, so it runs before the
  // site's own key handlers and can keep them from also reacting.
  const ACTIONS = {
    toggle: () => ({ overlay: !cfg.overlay }),
    collapse: () => ({ collapsed: !cfg.collapsed }),
    bigger: () => ({ scale: clampScale(cfg.scale + 0.1) }),
    smaller: () => ({ scale: clampScale(cfg.scale - 0.1) }),
  };
  addEventListener('keydown', e => {
    if (!cfg) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    const action = Object.keys(ACTIONS).find(a => cfg.keys[a] === combo);
    if (!action) return;
    if (!e.ctrlKey && !e.altKey && !e.metaKey && isEditable(e.composedPath()[0])) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && (action === 'toggle' || action === 'collapse')) return;
    const change = ACTIONS[action]();
    // Apply locally right away so held-down size keys keep stepping.
    cfg = withDefaults({ ...cfg, ...change });
    send();
    chrome.storage.local.set(change);
  }, true);

  // Codec lookups for direct video files, done by the background worker.
  // Capped per page so a page can't use us to make lots of requests.
  let sniffBudget = 20;
  document.addEventListener('__stream_inspector_sniff', e => {
    let req;
    try { req = JSON.parse(e.detail); } catch (_) { return; }
    const reply = codecs => document.dispatchEvent(new CustomEvent('__stream_inspector_sniffed', {
      detail: JSON.stringify({ id: req.id, codecs }),
    }));
    if (sniffBudget <= 0 || typeof req.src !== 'string' || !/^https?:/i.test(req.src)) return reply(null);
    sniffBudget--;
    chrome.runtime.sendMessage({ type: 'sniff', src: req.src })
      .then(codecs => reply(codecs || null), () => reply(null));
  });
})();
