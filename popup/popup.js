const list = document.getElementById('list');
const banner = document.getElementById('banner');
const toggle = document.getElementById('overlay');
let tabId = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function showBanner(text) {
  banner.textContent = text;
  banner.hidden = !text;
}

function fmtBps(b) {
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(b / 1e3)} kbps`;
}

function drawSpark(canvas, hist) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(40 * dpr);
  canvas.width = w;
  canvas.height = h;
  if (hist.length < 2) return;
  const css = getComputedStyle(document.documentElement);
  const ctx = canvas.getContext('2d');
  const max = Math.max(...hist) * 1.15;
  const step = w / 59;
  const x0 = w - (hist.length - 1) * step;
  const y = v => h - (v / max) * (h - 2 * dpr) - dpr;
  ctx.beginPath();
  ctx.moveTo(x0, h);
  hist.forEach((v, i) => ctx.lineTo(x0 + i * step, y(v)));
  ctx.lineTo(w, h);
  ctx.fillStyle = css.getPropertyValue('--accent-fill');
  ctx.fill();
  ctx.beginPath();
  hist.forEach((v, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x0 + i * step, y(v)));
  ctx.strokeStyle = css.getPropertyValue('--accent');
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  ctx.fillStyle = css.getPropertyValue('--muted');
  ctx.font = `${10 * dpr}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = 'top';
  ctx.fillText(`${fmtBps(max / 1.15)} · last 60 s`, 2 * dpr, 1 * dpr);
}

function render(videos) {
  if (!videos.length) {
    list.replaceChildren(el('div', 'empty', 'No video on this page yet. Start playing something.'));
    return;
  }
  list.replaceChildren(...videos.map(v => {
    const card = el('section', 'card');
    const head = el('div', 'card-head');
    head.append(
      el('span', 'summary', v.summary),
      el('span', 'frame', v.frame),
      el('span', v.paused ? 'state' : 'state playing', v.paused ? 'paused' : '● playing'),
    );
    const rows = el('div', 'rows');
    for (const row of v.rows) {
      const val = el('span', 'v');
      val.append(document.createTextNode(row.v));
      if (row.badge) val.append(el('span', 'badge', row.badge));
      if (row.sub) val.append(el('span', 'sub', row.sub));
      rows.append(el('span', 'k', row.k), val);
    }
    card.append(head, rows);
    if (v.hist.length > 1) {
      const canvas = el('canvas');
      card.append(canvas);
      requestAnimationFrame(() => drawSpark(canvas, v.hist));
    }
    return card;
  }));
}

function collect() {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: () => (window.__streamInspector ? window.__streamInspector.snapshot() : null),
  });
}

async function refresh(first) {
  let results;
  try {
    results = await collect();
  } catch (_) {
    showBanner('Chrome doesn’t let extensions inspect this page (browser pages, the Web Store, etc.).');
    list.replaceChildren();
    return false;
  }

  if (first && results.every(r => r.result == null)) {
    // The tab was open before the extension was installed, so the content
    // scripts never ran. Inject them now; bitrate works, codec needs a reload.
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['src/sniff.js', 'src/inject.js'] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['src/shared.js', 'src/bridge.js'] }).catch(() => {});
    showBanner('This tab was opened before the extension loaded. Bitrate is being measured now — reload the page to also see the codec.');
    results = await collect().catch(() => []);
  }

  const videos = results
    .flatMap(r => r.result || [])
    .sort((a, b) => (a.paused - b.paused) || (b.area - a.area));
  render(videos);
  return true;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;

  const cfg = StreamInspectorShared.withDefaults(await chrome.storage.local.get(StreamInspectorShared.DEFAULTS));
  toggle.checked = cfg.overlay;
  toggle.addEventListener('change', () => chrome.storage.local.set({ overlay: toggle.checked }));

  document.getElementById('shortcut').textContent = cfg.keys.toggle || '';
  document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  if (tabId == null) return;
  if (await refresh(true)) setInterval(() => refresh(false), 1000);
}

init();
