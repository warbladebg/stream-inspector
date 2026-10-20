const S = StreamInspectorShared;
const $ = id => document.getElementById(id);

// Chrome handles these itself before any page sees them.
const RESERVED = new Set([
  'Ctrl+T', 'Ctrl+N', 'Ctrl+W', 'Ctrl+Q', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Shift+Q',
  'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Alt+F4', 'Ctrl+F4', 'Ctrl+Shift+Delete',
]);

let cfg = S.withDefaults({});
let recording = null; // action currently being recorded
const rows = {};

let savedTimer;
function save(change) {
  cfg = S.withDefaults({ ...cfg, ...change });
  chrome.storage.local.set(change);
  const el = $('saved');
  el.textContent = 'Saved';
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ------------------------------------------------------------- stats panel

function renderPanel() {
  $('overlay').checked = cfg.overlay;
  $('collapsed').checked = cfg.collapsed;
  const pct = Math.round(cfg.scale * 100);
  $('scale').value = pct;
  $('scale-value').textContent = `${pct}%`;
  const panel = $('preview-panel');
  panel.style.zoom = String(cfg.scale);
  panel.classList.toggle('collapsed', cfg.collapsed);
  $('preview-min').textContent = cfg.collapsed ? '+' : '–';
}

$('overlay').addEventListener('change', e => save({ overlay: e.target.checked }));
$('collapsed').addEventListener('change', e => { save({ collapsed: e.target.checked }); renderPanel(); });
$('scale').addEventListener('input', e => { save({ scale: S.clampScale(e.target.value / 100) }); renderPanel(); });
$('scale-reset').addEventListener('click', () => { save({ scale: S.DEFAULTS.scale }); renderPanel(); });

// --------------------------------------------------------------- shortcuts

function buildKeys() {
  const box = $('keys');
  for (const [action, meta] of Object.entries(S.ACTIONS)) {
    const row = el('div', 'key-row');
    const text = el('span', 'text');
    text.append(el('span', 'name', meta.label), el('span', 'help', meta.help));
    const combo = el('button', 'combo');
    combo.type = 'button';
    combo.setAttribute('aria-label', `Shortcut for ${meta.label}`);
    const clear = el('button', 'clear', '×');
    clear.type = 'button';
    clear.title = 'Remove shortcut';
    clear.setAttribute('aria-label', `Remove shortcut for ${meta.label}`);
    const error = el('div', 'error');
    error.setAttribute('role', 'alert');
    row.append(text, combo, clear, error);
    box.append(row);
    rows[action] = { combo, clear, error };

    combo.addEventListener('click', () => (recording === action ? stopRecording() : startRecording(action)));
    combo.addEventListener('blur', () => { if (recording === action) stopRecording(); });
    clear.addEventListener('click', () => { setKey(action, ''); });
  }
}

function renderKeys() {
  for (const [action, r] of Object.entries(rows)) {
    if (recording === action) continue;
    const combo = cfg.keys[action];
    r.combo.textContent = combo || 'Not set';
    r.combo.classList.toggle('unset', !combo);
    r.combo.classList.remove('recording');
    r.clear.disabled = !combo;
  }
}

function startRecording(action) {
  if (recording) stopRecording();
  recording = action;
  const r = rows[action];
  r.error.textContent = '';
  r.combo.textContent = 'Press keys…';
  r.combo.classList.add('recording');
  r.combo.classList.remove('unset');
  r.combo.focus();
}

function stopRecording() {
  recording = null;
  renderKeys();
}

function setKey(action, combo) {
  rows[action].error.textContent = '';
  save({ keys: { ...cfg.keys, [action]: combo } });
  stopRecording();
}

function onKey(e) {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  const r = rows[recording];
  const mods = S.modifiers(e);
  if (!mods.length && e.key === 'Escape') return stopRecording();
  if (!mods.length && (e.code === 'Backspace' || e.code === 'Delete')) return setKey(recording, '');

  const combo = S.comboFromEvent(e);
  if (!combo) {
    // Only modifiers held so far: show them while the user keeps going.
    r.combo.textContent = mods.length ? `${mods.join('+')}+…` : 'Press keys…';
    return;
  }
  if (e.type !== 'keydown') return;

  const problem = S.comboProblem(combo);
  const taken = Object.keys(cfg.keys).find(a => a !== recording && cfg.keys[a] === combo);
  if (problem) r.error.textContent = `${combo}: ${problem}`;
  else if (RESERVED.has(combo)) r.error.textContent = `${combo} is reserved by Chrome. Pick another one.`;
  else if (taken) r.error.textContent = `${combo} is already used for “${S.ACTIONS[taken].label}”.`;
  else return setKey(recording, combo);
  r.combo.textContent = 'Press keys…';
}
document.addEventListener('keydown', onKey, true);
document.addEventListener('keyup', onKey, true);

$('keys-reset').addEventListener('click', () => {
  for (const r of Object.values(rows)) r.error.textContent = '';
  save({ keys: { ...S.DEFAULTS.keys } });
  renderKeys();
});

// ------------------------------------------------------------------ init

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const next = { ...cfg };
  for (const k of Object.keys(S.DEFAULTS)) if (changes[k]) next[k] = changes[k].newValue;
  cfg = S.withDefaults(next);
  renderPanel();
  renderKeys();
});

buildKeys();
chrome.storage.local.get(S.DEFAULTS).then(v => {
  cfg = S.withDefaults(v);
  renderPanel();
  renderKeys();
});
