// Settings defaults and shortcut helpers, shared by the options page, the
// popup and the content-script bridge.
(() => {
  if (self.StreamInspectorShared) return;

  const DEFAULTS = {
    overlay: true,
    scale: 1,
    collapsed: false,
    keys: {
      toggle: 'Alt+Shift+S',
      collapse: 'Alt+Shift+C',
      bigger: 'Alt+Shift+=',
      smaller: 'Alt+Shift+-',
    },
  };

  const ACTIONS = {
    toggle: { label: 'Show / hide stats', help: 'Turns the overlay on or off on every tab' },
    collapse: { label: 'Collapse / expand', help: 'Shrinks panels to a one-line summary' },
    bigger: { label: 'Bigger panel', help: 'Increases the panel size by 10%' },
    smaller: { label: 'Smaller panel', help: 'Decreases the panel size by 10%' },
  };

  const SCALE_MIN = 0.6, SCALE_MAX = 2;
  const clampScale = s => Math.round(Math.min(Math.max(Number(s) || 1, SCALE_MIN), SCALE_MAX) * 100) / 100;

  // Uses event.code (physical key) so shortcuts work the same on any keyboard
  // layout, e.g. Cyrillic, and Alt/Shift don't change the key name.
  const CODE_NAMES = {
    Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', Space: 'Space',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
    NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadDecimal: 'Num.',
  };

  function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return 'Num' + code.slice(6);
    if (/^F\d{1,2}$/.test(code)) return code;
    return CODE_NAMES[code] || null;
  }

  function modifiers(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');
    return parts;
  }

  // "Alt+Shift+S", or null for a modifier on its own / an unsupported key.
  function comboFromEvent(e) {
    const key = keyName(e.code);
    return key ? [...modifiers(e), key].join('+') : null;
  }

  // Shortcuts need Ctrl/Alt/Win (or an F-key) so they never fire while typing.
  function comboProblem(combo) {
    const parts = combo.split('+');
    const key = combo.endsWith('++') ? '+' : parts[parts.length - 1];
    if (/^F\d{1,2}$/.test(key)) return null;
    if (!parts.some(p => p === 'Ctrl' || p === 'Alt' || p === 'Win')) return 'Add Ctrl or Alt so it doesn’t fire while you type.';
    return null;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|color|file|image)$/i.test(el.type);
  }

  // Stored values merged over the defaults (keys is merged one level deep).
  function withDefaults(v) {
    return { ...DEFAULTS, ...v, scale: clampScale(v && v.scale), keys: { ...DEFAULTS.keys, ...(v && v.keys) } };
  }

  self.StreamInspectorShared = Object.freeze({
    DEFAULTS, ACTIONS, SCALE_MIN, SCALE_MAX, clampScale, comboFromEvent, modifiers, comboProblem, isEditable, withDefaults,
  });
})();
