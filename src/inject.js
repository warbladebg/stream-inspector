// Runs in the page's MAIN world at document_start, before any site script.
// It wraps a few media APIs (MediaSource, SourceBuffer, RTCPeerConnection, EME)
// so it can see the codec strings players hand to the browser, samples the
// decoder byte counters once a second to compute real bitrates, and draws a
// small stats panel over each video.
(() => {
  'use strict';
  if (window.__streamInspector) return;

  const safe = (fn, fallback) => {
    try { return fn(); } catch (_) { return fallback; }
  };

  // Replace obj[name] with a Proxy so the original keeps its native toString,
  // length, etc. The wrapper must always call through; our own bookkeeping is
  // wrapped in safe() so it can never break the page.
  function hook(obj, name, wrap) {
    const desc = obj && Object.getOwnPropertyDescriptor(obj, name);
    if (!desc || typeof desc.value !== 'function') return;
    const proxy = new Proxy(desc.value, {
      apply: (target, self, args) => wrap(target, self, args),
    });
    safe(() => Object.defineProperty(obj, name, { ...desc, value: proxy }));
  }

  // ------------------------------------------------------------------ codecs

  const TRANSFER = { 16: 'HDR10 (PQ)', 18: 'HLG' };

  function avc(parts, name = 'H.264 (AVC)') {
    let profile, constraints = 0, level;
    if (parts.length >= 3 && /^\d+$/.test(parts[1])) {
      // Legacy decimal form, e.g. "avc1.66.30"
      profile = +parts[1];
      level = +parts[2];
    } else if (parts[1] && parts[1].length >= 6) {
      profile = parseInt(parts[1].slice(0, 2), 16);
      constraints = parseInt(parts[1].slice(2, 4), 16);
      level = parseInt(parts[1].slice(4, 6), 16);
    }
    const names = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' };
    const out = [];
    if (profile) out.push(profile === 66 && constraints & 0x40 ? 'Constrained Baseline' : names[profile] || `Profile ${profile}`);
    if (level) out.push(`L${level === 9 ? '1b' : (level / 10).toFixed(1)}`);
    return { kind: 'video', name, detail: out.join(' · ') };
  }

  function hevc(parts, name = 'H.265 (HEVC)') {
    const out = [];
    const profile = parseInt((parts[1] || '').replace(/^[A-C]/i, ''), 10);
    const names = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions', 5: 'High Throughput', 9: 'Screen Content' };
    if (profile) out.push(names[profile] || `Profile ${profile}`);
    const tl = /^([LH])(\d+)/i.exec(parts[3] || '');
    if (tl) {
      out.push(`L${(tl[2] / 30).toFixed(1)}`);
      if (tl[1].toUpperCase() === 'H') out.push('High tier');
    }
    return { kind: 'video', name, detail: out.join(' · ') };
  }

  // vp09.PP.LL.DD.CC.cp.tc.mc.FF
  function vp9(parts) {
    const out = [];
    if (parts[1] != null) out.push(`Profile ${+parts[1]}`);
    if (parts[2]) out.push(`L${(+parts[2] / 10).toFixed(1)}`);
    if (parts[3]) out.push(`${+parts[3]}-bit`);
    return { kind: 'video', name: 'VP9', detail: out.join(' · '), hdr: TRANSFER[+parts[6]] };
  }

  // av01.P.LLT.DD.M.CCC.cp.tc.mc.F
  function av1(parts, name = 'AV1') {
    const out = [];
    const names = { 0: 'Main', 1: 'High', 2: 'Professional' };
    if (parts[1] != null) out.push(names[+parts[1]] || `Profile ${parts[1]}`);
    const lt = /^(\d+)([MH])?/i.exec(parts[2] || '');
    if (lt) {
      const idx = +lt[1];
      out.push(`L${2 + (idx >> 2)}.${idx & 3}`);
      if ((lt[2] || '').toUpperCase() === 'H') out.push('High tier');
    }
    if (parts[3]) out.push(`${+parts[3]}-bit`);
    return { kind: 'video', name, detail: out.join(' · '), hdr: TRANSFER[+parts[7]] };
  }

  function mp4a(parts) {
    const oti = (parts[1] || '').toLowerCase();
    const aot = +parts[2];
    const AOT = { 1: 'AAC Main', 2: 'AAC-LC', 5: 'HE-AAC', 29: 'HE-AAC v2', 34: 'MP3', 42: 'xHE-AAC' };
    let name = 'AAC';
    if (oti === '40') name = AOT[aot] || `MPEG-4 Audio (type ${aot})`;
    else if (oti === '66' || oti === '67' || oti === '68') name = 'AAC (MPEG-2)';
    else if (oti === '69' || oti === '6b') name = 'MP3';
    else if (oti === 'a5') name = 'Dolby Digital (AC-3)';
    else if (oti === 'a6') name = 'Dolby Digital Plus (E-AC-3)';
    return { kind: 'audio', name };
  }

  const SIMPLE = {
    vp8: ['video', 'VP8'], vp9: ['video', 'VP9'], theora: ['video', 'Theora'], mp4v: ['video', 'MPEG-4 Part 2'],
    opus: ['audio', 'Opus'], vorbis: ['audio', 'Vorbis'], flac: ['audio', 'FLAC'], mp3: ['audio', 'MP3'],
    'ac-3': ['audio', 'Dolby Digital (AC-3)'], 'ec-3': ['audio', 'Dolby Digital Plus (E-AC-3)'], 'ac-4': ['audio', 'Dolby AC-4'],
    mhm1: ['audio', 'MPEG-H 3D Audio'], mha1: ['audio', 'MPEG-H 3D Audio'], alac: ['audio', 'Apple Lossless'],
    dtsc: ['audio', 'DTS'], dtse: ['audio', 'DTS Express'], dtsh: ['audio', 'DTS-HD'], dtsl: ['audio', 'DTS-HD MA'], dtsx: ['audio', 'DTS:X'],
    pcm: ['audio', 'PCM'], ulaw: ['audio', 'G.711 µ-law'], alaw: ['audio', 'G.711 A-law'],
  };

  function describeCodec(raw) {
    const parts = raw.trim().split('.');
    const id = parts[0].toLowerCase();
    let c;
    switch (id) {
      case 'avc1': case 'avc3': c = avc(parts); break;
      case 'hvc1': case 'hev1': c = hevc(parts); break;
      case 'vp09': c = vp9(parts); break;
      case 'av01': c = av1(parts); break;
      case 'mp4a': c = mp4a(parts); break;
      case 'dvh1': case 'dvhe':
        c = { kind: 'video', name: 'Dolby Vision (HEVC)', detail: parts[1] ? `Profile ${+parts[1]}` : '', hdr: 'Dolby Vision' };
        break;
      case 'dva1': case 'dvav':
        c = { kind: 'video', name: 'Dolby Vision (H.264)', detail: parts[1] ? `Profile ${+parts[1]}` : '', hdr: 'Dolby Vision' };
        break;
      case 'dav1':
        c = { kind: 'video', name: 'Dolby Vision (AV1)', detail: parts[1] ? `Profile ${+parts[1]}` : '', hdr: 'Dolby Vision' };
        break;
      default:
        c = SIMPLE[id] ? { kind: SIMPLE[id][0], name: SIMPLE[id][1] } : { kind: 'unknown', name: raw };
    }
    return { raw, ...c };
  }

  // WebRTC reports codecs as "video/H264" plus an SDP fmtp line.
  function describeRtcCodec(mime = '', fmtp = '') {
    const sub = (mime.split('/')[1] || '').toLowerCase();
    let c;
    if (sub === 'h264') {
      const m = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp);
      c = avc(['avc1', m ? m[1] : '']);
    } else if (sub === 'h265') {
      c = { kind: 'video', name: 'H.265 (HEVC)' };
    } else if (sub === 'vp9') {
      const m = /profile-id=(\d)/.exec(fmtp);
      c = { kind: 'video', name: 'VP9', detail: m ? `Profile ${m[1]}` : '' };
    } else if (sub === 'av1') {
      c = { kind: 'video', name: 'AV1' };
    } else if (sub === 'pcmu') {
      c = { kind: 'audio', name: 'G.711 µ-law' };
    } else if (sub === 'pcma') {
      c = { kind: 'audio', name: 'G.711 A-law' };
    } else if (sub === 'g722') {
      c = { kind: 'audio', name: 'G.722' };
    } else {
      c = describeCodec(sub);
    }
    return { ...c, raw: [mime, fmtp].filter(Boolean).join('; ') };
  }

  const CONTAINERS = {
    'video/mp4': 'MP4', 'audio/mp4': 'MP4', 'video/webm': 'WebM', 'audio/webm': 'WebM',
    'video/mp2t': 'MPEG-TS', 'audio/mpeg': 'MPEG audio', 'audio/aac': 'ADTS',
    'video/ogg': 'Ogg', 'audio/ogg': 'Ogg', 'video/quicktime': 'QuickTime', 'video/x-matroska': 'Matroska',
  };
  const IMPLIED_CODEC = { 'audio/mpeg': 'mp3', 'audio/aac': 'mp4a.40.2' };

  function parseMime(mime) {
    const type = mime.split(';')[0].trim().toLowerCase();
    const m = /codecs\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/i.exec(mime);
    let codecs = m ? (m[1] ?? m[2] ?? m[3]).split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!codecs.length && IMPLIED_CODEC[type]) codecs = [IMPLIED_CODEC[type]];
    return { type, codecs };
  }

  // ------------------------------------------------------- MSE bookkeeping

  const sbInfo = new WeakMap();   // SourceBuffer -> info
  const blobToMs = new Map();     // blob: URL -> MediaSource (bounded)
  const videoToMs = new WeakMap();
  const msList = [];              // recent MediaSources, for fallback matching

  function setMime(info, mime) {
    const { type, codecs } = parseMime(mime);
    info.container = CONTAINERS[type] || type;
    info.codecs = codecs.map(describeCodec);
    const kinds = new Set(info.codecs.map(c => c.kind));
    if (!kinds.size || kinds.has('unknown')) kinds.add(type.startsWith('audio/') ? 'audio' : 'video');
    info.hasVideo = kinds.has('video');
    info.hasAudio = kinds.has('audio');
  }

  function bufferedSeconds(sb) {
    const b = sb.buffered;
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b.end(i) - b.start(i);
    return s;
  }

  function rememberMs(ms) {
    if (!msList.includes(ms)) {
      msList.push(ms);
      if (msList.length > 16) msList.shift();
    }
  }

  function trackSourceBuffer(ms, sb, mime) {
    const info = { segs: [], pending: null };
    setMime(info, mime);
    sbInfo.set(sb, info);
    rememberMs(ms);
    // After each append, (bytes appended) / (seconds of media added) is the
    // encoded bitrate of the segment the player just downloaded.
    sb.addEventListener('updateend', () => safe(() => {
      const p = info.pending;
      info.pending = null;
      if (!p) return;
      const dur = bufferedSeconds(sb) - p.before;
      if (dur > 0.1) {
        const bits = p.bytes * 8;
        if (bits / dur < 4e8) {
          info.segs.push({ bits, dur });
          if (info.segs.length > 8) info.segs.shift();
        }
      }
    }));
    sb.addEventListener('abort', () => { info.pending = null; });
  }

  // Players declare one codec string up front (often the first quality level's)
  // and may not update it on quality switches. Init segments carry the real
  // decoder config, so parse them when they go by.
  function readInitSegment(info, data) {
    const S = window.__streamInspectorSniff;
    if (!S || !data || !data.byteLength) return;
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data, 0, Math.min(data.byteLength, 65536))
      : new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 65536));
    const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    if (box !== 'ftyp' && box !== 'moov' && !webm) return;
    const found = S.parse(bytes);
    if (found) info.initCodecs = found.map(x => ({ ...describeCodec(x.codec), raw: x.raw }));
  }

  function segmentRate(info) {
    let bits = 0, dur = 0;
    for (const s of info.segs) { bits += s.bits; dur += s.dur; }
    return dur > 0 ? bits / dur : null;
  }

  if (window.MediaSource) {
    hook(MediaSource.prototype, 'addSourceBuffer', (orig, ms, args) => {
      const sb = Reflect.apply(orig, ms, args);
      safe(() => trackSourceBuffer(ms, sb, String(args[0])));
      return sb;
    });
  }
  if (window.SourceBuffer) {
    hook(SourceBuffer.prototype, 'appendBuffer', (orig, sb, args) => {
      safe(() => {
        const info = sbInfo.get(sb);
        if (!info) return;
        info.pending = { bytes: (args[0] && args[0].byteLength) || 0, before: bufferedSeconds(sb) };
        readInitSegment(info, args[0]);
      });
      return Reflect.apply(orig, sb, args);
    });
    hook(SourceBuffer.prototype, 'changeType', (orig, sb, args) => {
      const r = Reflect.apply(orig, sb, args);
      safe(() => {
        const info = sbInfo.get(sb);
        if (info) { setMime(info, String(args[0])); info.initCodecs = null; info.segs.length = 0; }
      });
      return r;
    });
  }
  hook(URL, 'createObjectURL', (orig, self, args) => {
    const url = Reflect.apply(orig, self, args);
    safe(() => {
      if (window.MediaSource && args[0] instanceof MediaSource) {
        blobToMs.set(url, args[0]);
        rememberMs(args[0]);
        if (blobToMs.size > 32) blobToMs.delete(blobToMs.keys().next().value);
      }
    });
    return url;
  });

  function mediaSourceFor(video, src) {
    if (!src.startsWith('blob:')) return null;
    const direct = blobToMs.get(src);
    if (direct) { videoToMs.set(video, direct); return direct; }
    const known = videoToMs.get(video);
    if (known && known.readyState !== 'closed') return known;
    // Blob URL already revoked or created elsewhere: if exactly one
    // MediaSource is attached somewhere, it's almost certainly this one.
    const open = msList.filter(m => m.readyState !== 'closed');
    return open.length === 1 ? open[0] : null;
  }

  // ------------------------------------------------------------------- DRM

  const mkSystem = new WeakMap();
  let lastKeySystem = null;
  if (window.MediaKeySystemAccess) {
    hook(MediaKeySystemAccess.prototype, 'createMediaKeys', (orig, access, args) => {
      const p = Reflect.apply(orig, access, args);
      safe(() => {
        const ks = access.keySystem;
        lastKeySystem = ks;
        p.then(mk => mkSystem.set(mk, ks), () => {});
      });
      return p;
    });
  }

  function keySystemName(ks) {
    if (!ks) return 'Encrypted';
    if (/widevine/i.test(ks)) return 'Widevine';
    if (/playready/i.test(ks)) return 'PlayReady';
    if (/clearkey/i.test(ks)) return 'ClearKey';
    if (/fairplay|\.fps/i.test(ks)) return 'FairPlay';
    return ks;
  }

  // ---------------------------------------------------------------- WebRTC

  const pcs = new Set();
  const rtcTracks = new Map(); // receiver track id -> latest inbound-rtp stats

  if (window.RTCPeerConnection) {
    const Orig = window.RTCPeerConnection;
    const Wrapped = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
        safe(() => pcs.add(pc));
        return pc;
      },
    });
    safe(() => {
      window.RTCPeerConnection = Wrapped;
      if (window.webkitRTCPeerConnection === Orig) window.webkitRTCPeerConnection = Wrapped;
    });
  }

  let rtcBusy = false;
  function pollRtc() {
    if (!pcs.size || rtcBusy) return;
    rtcBusy = true;
    const jobs = [];
    for (const pc of pcs) {
      if (pc.signalingState === 'closed') { pcs.delete(pc); continue; }
      jobs.push(pc.getStats().then(readRtc, () => {}));
    }
    Promise.all(jobs).finally(() => { rtcBusy = false; });
  }

  function readRtc(report) {
    const now = performance.now();
    report.forEach(r => {
      if (r.type !== 'inbound-rtp' || !r.trackIdentifier) return;
      const prev = rtcTracks.get(r.trackIdentifier);
      const codec = r.codecId && report.get(r.codecId);
      const e = {
        kind: r.kind || r.mediaType,
        ts: r.timestamp,
        bytes: r.bytesReceived,
        codec: codec ? describeRtcCodec(codec.mimeType, codec.sdpFmtpLine) : prev && prev.codec,
        fps: r.framesPerSecond,
        bps: prev ? prev.bps : null,
        seen: now,
      };
      if (prev && r.timestamp > prev.ts) e.bps = (r.bytesReceived - prev.bytes) * 8 / ((r.timestamp - prev.ts) / 1000);
      rtcTracks.set(r.trackIdentifier, e);
    });
    for (const [id, e] of rtcTracks) if (now - e.seen > 30000) rtcTracks.delete(id);
  }

  // ------------------------------------------------------- video discovery

  const shadowRoots = [];  // WeakRef<ShadowRoot>, so videos inside web components are found
  const playedVideos = []; // WeakRef<HTMLVideoElement>
  const playedSeen = new WeakSet();
  const ownHosts = new WeakSet();

  hook(Element.prototype, 'attachShadow', (orig, el, args) => {
    const root = Reflect.apply(orig, el, args);
    safe(() => { if (!ownHosts.has(el)) shadowRoots.push(new WeakRef(root)); });
    return root;
  });
  if (window.HTMLMediaElement) {
    hook(HTMLMediaElement.prototype, 'play', (orig, el, args) => {
      safe(() => {
        if (el instanceof HTMLVideoElement && !playedSeen.has(el)) {
          playedSeen.add(el);
          playedVideos.push(new WeakRef(el));
        }
      });
      return Reflect.apply(orig, el, args);
    });
  }

  function collectRefs(refs, fn) {
    for (let i = refs.length - 1; i >= 0; i--) {
      const x = refs[i].deref();
      if (x) fn(x); else refs.splice(i, 1);
    }
  }

  function findVideos() {
    const set = new Set(document.querySelectorAll('video'));
    collectRefs(shadowRoots, r => r.querySelectorAll('video').forEach(v => set.add(v)));
    collectRefs(playedVideos, v => set.add(v));
    return [...set].filter(v => v.isConnected);
  }

  // -------------------------------------------------------------- sampling

  const states = new WeakMap();
  const WINDOW = 5; // samples (≈ seconds) in the rolling bitrate window

  function stateFor(v) {
    let st = states.get(v);
    if (st) return st;
    st = {
      prev: null, samples: [], hist: [], totals: { dt: 0, v: 0, a: 0 }, peak: 0,
      dismissed: false, collapsed: collapsedDefault, overlay: null, stats: null,
    };
    states.set(v, st);
    const reset = () => { st.prev = null; st.samples.length = 0; };
    v.addEventListener('seeking', reset);
    v.addEventListener('emptied', () => {
      reset();
      st.hist.length = 0;
      st.totals = { dt: 0, v: 0, a: 0 };
      st.peak = 0;
    });
    return st;
  }

  // Chrome counts the compressed bytes it hands to the decoders. Dividing the
  // delta by how much *media time* elapsed gives the content bitrate, and it
  // works the same for MSE, plain files and HLS.
  function sample(v, st) {
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    const cur = {
      t: v.currentTime,
      vb: v.webkitVideoDecodedByteCount || 0,
      ab: v.webkitAudioDecodedByteCount || 0,
      frames: q ? q.totalVideoFrames : 0,
    };
    const p = st.prev;
    st.prev = cur;
    if (!p || v.paused || v.seeking) return;
    const dt = cur.t - p.t;
    const dv = cur.vb - p.vb, da = cur.ab - p.ab, df = cur.frames - p.frames;
    if (dt <= 0.1 || dt > 5 || dv < 0 || da < 0 || df < 0) return;
    st.samples.push({ dt, dv, da, df });
    if (st.samples.length > WINDOW) st.samples.shift();
    st.totals.dt += dt;
    st.totals.v += dv;
    st.totals.a += da;
  }

  function bufferAhead(v) {
    const b = v.buffered, t = v.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.1 && b.end(i) >= t) return Math.max(0, b.end(i) - t);
    }
    return b.length ? 0 : null;
  }

  function extContainer(src) {
    const m = /\.(mp4|m4v|webm|mkv|mov|ogv|ogg|ts|m3u8|mpd)(?:[?#]|$)/i.exec(src);
    if (!m) return null;
    const map = { mp4: 'MP4', m4v: 'MP4', webm: 'WebM', mkv: 'Matroska', mov: 'QuickTime', ogv: 'Ogg', ogg: 'Ogg', ts: 'MPEG-TS', m3u8: 'HLS', mpd: 'DASH' };
    return map[m[1].toLowerCase()];
  }

  // ------------------------------------------- direct-file header sniffing

  // For plain <video src="file.mp4"> there's no MSE call to observe. The
  // background worker reads the file's container header (it isn't bound by
  // CORS) and sends back just the codec strings, relayed through bridge.js.
  const sniffed = new Map(); // src -> codec list | 'pending' | null
  let sniffSeq = 0;
  const sniffWaiting = new Map();

  document.addEventListener('__stream_inspector_sniffed', e => {
    const msg = safe(() => JSON.parse(e.detail), null);
    const done = msg && sniffWaiting.get(msg.id);
    if (!done) return;
    sniffWaiting.delete(msg.id);
    done(msg.codecs);
  });

  function requestSniff(src) {
    return new Promise(resolve => {
      const id = ++sniffSeq;
      sniffWaiting.set(id, resolve);
      setTimeout(() => { if (sniffWaiting.delete(id)) resolve(null); }, 15000);
      document.dispatchEvent(new CustomEvent('__stream_inspector_sniff', { detail: JSON.stringify({ id, src }) }));
    });
  }

  function fileCodecs(src) {
    if (!sniffed.has(src)) {
      if (sniffed.size > 20) sniffed.delete(sniffed.keys().next().value);
      sniffed.set(src, 'pending');
      requestSniff(src).then(list => {
        sniffed.set(src, Array.isArray(list) && list.length
          ? list.map(x => ({ ...describeCodec(String(x.codec)), raw: String(x.raw) }))
          : null);
      });
    }
    const c = sniffed.get(src);
    return Array.isArray(c) ? c : null;
  }

  function computeStats(v, st) {
    const s = {
      w: v.videoWidth, h: v.videoHeight,
      live: v.duration === Infinity,
      vcodecs: [], acodecs: [],
    };

    let dt = 0, dv = 0, da = 0, df = 0;
    for (const x of st.samples) { dt += x.dt; dv += x.dv; da += x.da; df += x.df; }
    if (dt > 0) {
      if (dv > 0) s.vbps = dv * 8 / dt;
      if (da > 0) s.abps = da * 8 / dt;
      if (df > 0) s.fps = df / dt;
    }
    if (st.totals.dt > 3 && st.totals.v > 0) {
      s.avgV = st.totals.v * 8 / st.totals.dt;
      if (st.totals.a > 0) s.avgA = st.totals.a * 8 / st.totals.dt;
    }

    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    if (q) { s.dropped = q.droppedVideoFrames; s.frames = q.totalVideoFrames; }
    s.ahead = safe(() => bufferAhead(v), null);

    const src = v.currentSrc || v.src || '';
    const stream = typeof MediaStream !== 'undefined' && v.srcObject instanceof MediaStream ? v.srcObject : null;
    const ms = stream ? null : mediaSourceFor(v, src);

    if (stream) {
      s.source = 'WebRTC / MediaStream';
      let found = false;
      for (const t of stream.getTracks()) {
        const r = rtcTracks.get(t.id);
        if (!r) continue;
        found = true;
        if (r.kind === 'video') {
          if (r.codec) s.vcodecs.push(r.codec);
          if (r.bps != null) s.vbps = r.bps;
          if (r.fps) s.fps = r.fps;
        } else {
          if (r.codec) s.acodecs.push(r.codec);
          if (r.bps != null) s.abps = r.bps;
        }
      }
      if (!found) s.note = pcs.size ? 'Waiting for WebRTC stats…' : 'Local capture (camera/screen) — not an encoded stream';
    } else if (ms) {
      s.source = 'MSE';
      const list = safe(() => ms.sourceBuffers, null);
      for (let i = 0; list && i < list.length; i++) {
        const info = sbInfo.get(list[i]);
        if (!info) continue;
        s.container = info.container;
        for (const c of info.initCodecs || info.codecs) (c.kind === 'audio' ? s.acodecs : s.vcodecs).push(c);
        const r = segmentRate(info);
        if (r) {
          if (info.hasVideo) { s.segV = r; s.muxed = info.hasAudio; } else s.segA = r;
        }
      }
    } else if (src.startsWith('blob:')) {
      s.source = 'MSE';
      s.note = 'Reload the page to detect the codec';
    } else if (src) {
      const c = extContainer(src);
      s.source = c === 'HLS' ? 'HLS (native)' : 'Direct file';
      if (c && c !== 'HLS') s.container = c;
      const tagged = [...v.querySelectorAll('source[type]')].find(e => e.src === src);
      if (tagged) {
        const { type, codecs } = parseMime(tagged.type);
        s.container = CONTAINERS[type] || s.container;
        for (const c of codecs.map(describeCodec)) (c.kind === 'audio' ? s.acodecs : s.vcodecs).push(c);
      }
      if (!s.vcodecs.length && !s.acodecs.length && /^https?:/.test(src) && c !== 'HLS') {
        const found = fileCodecs(src);
        if (found) for (const c of found) (c.kind === 'audio' ? s.acodecs : s.vcodecs).push(c);
        else if (sniffed.get(src) === null) s.note = 'Couldn’t read the file header, so the codec is unknown';
      }
    }

    if (v.mediaKeys) s.drm = keySystemName(mkSystem.get(v.mediaKeys) || lastKeySystem);

    // No decoder counters (or a stream type without them): fall back to the
    // bitrate of the segments being buffered.
    if (s.vbps == null && s.segV) s.vbps = s.segV;
    if (s.abps == null && s.segA) s.abps = s.segA;

    if (!v.paused && s.vbps) {
      st.hist.push(s.vbps);
      if (st.hist.length > 60) st.hist.shift();
      if (st.samples.length >= 3 || stream) st.peak = Math.max(st.peak, s.vbps);
    }
    s.peakV = st.peak || null;

    s.summary = summaryLine(s);
    s.rows = buildRows(s);
    return s;
  }

  // ------------------------------------------------------------ formatting

  function fmtBps(b) {
    if (b == null || !isFinite(b)) return '—';
    if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 2)} Mbps`;
    if (b >= 1e3) return `${Math.round(b / 1e3)} kbps`;
    return `${Math.round(b)} bps`;
  }

  // Measured frame rates wobble by a frame or two; snap to the usual rates.
  const RATES = [24, 25, 30, 48, 50, 60, 90, 100, 120, 144, 240];
  function fmtFps(f) {
    const near = RATES.find(r => Math.abs(f - r) / r < 0.04);
    return String(near || Math.round(f));
  }

  const STD = [[7680, 4320], [3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [854, 480], [640, 360], [426, 240], [256, 144]];
  function qualityLabel(w, h) {
    if (!w || !h) return '';
    const long = Math.max(w, h), short = Math.min(w, h);
    for (const [W, H] of STD) if (long >= W * 0.95 || short >= H * 0.95) return `${H}p`;
    return `${short}p`;
  }

  function codecName(list) {
    return list.length ? [...new Set(list.map(c => c.name))].join(' + ') : '';
  }

  function summaryLine(s) {
    const q = qualityLabel(s.w, s.h);
    const fps = s.fps && s.fps >= 48 ? fmtFps(s.fps) : '';
    return [q && q + fps, codecName(s.vcodecs), s.vbps && fmtBps(s.vbps)].filter(Boolean).join(' · ') || 'Video';
  }

  function codecRow(k, list) {
    if (!list.length) return { k, v: '—' };
    const seen = new Set();
    const uniq = list.filter(c => !seen.has(c.raw) && seen.add(c.raw));
    return {
      k,
      v: uniq.map(c => (c.detail ? `${c.name} · ${c.detail}` : c.name)).join(' + '),
      badge: (uniq.find(c => c.hdr) || {}).hdr,
      sub: uniq.map(c => c.raw).filter(Boolean).join(', '),
    };
  }

  function buildRows(s) {
    const rows = [];
    rows.push({
      k: 'Resolution',
      v: (s.w ? `${s.w}×${s.h}` : '—') + (s.fps ? ` @ ${fmtFps(s.fps)} fps` : ''),
    });
    rows.push(codecRow('Video', s.vcodecs));
    rows.push(codecRow('Audio', s.acodecs));
    if (s.vbps || s.abps) {
      rows.push({
        k: 'Bitrate',
        v: [s.vbps && `${fmtBps(s.vbps)} video`, s.abps && `${fmtBps(s.abps)} audio`].filter(Boolean).join(' · '),
      });
    }
    if (s.avgV) {
      rows.push({
        k: 'Average',
        v: `${fmtBps(s.avgV)}` + (s.peakV ? ` · peak ${fmtBps(s.peakV)}` : ''),
        sub: s.avgA ? `audio avg ${fmtBps(s.avgA)}` : '',
      });
    }
    if (s.segV || s.segA) {
      rows.push({
        k: 'Buffering',
        v: [s.segV && `${fmtBps(s.segV)} ${s.muxed ? 'muxed' : 'video'}`, s.segA && `${fmtBps(s.segA)} audio`].filter(Boolean).join(' · '),
        sub: 'bitrate of segments being downloaded',
      });
    }
    if (s.frames) {
      const pct = s.dropped / s.frames * 100;
      rows.push({ k: 'Dropped', v: `${s.dropped.toLocaleString()} / ${s.frames.toLocaleString()} frames (${pct.toFixed(pct < 1 ? 2 : 1)}%)` });
    }
    if (s.ahead != null && !s.source?.startsWith('WebRTC')) rows.push({ k: 'Buffer', v: `${s.ahead.toFixed(1)} s ahead` });
    rows.push({
      k: 'Source',
      v: [s.source || '—', s.container, s.live && 'Live', s.drm && `DRM: ${s.drm}`].filter(Boolean).join(' · '),
    });
    if (s.note) rows.push({ k: 'Note', v: s.note });
    return rows;
  }

  // --------------------------------------------------------------- overlay

  const CSS = `
    :host { all: initial; }
    .panel {
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #e8e8e8; background: rgba(14, 15, 18, 0.84);
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px;
      padding: 6px 8px 8px; width: 300px; box-sizing: border-box;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
      pointer-events: auto; user-select: text; cursor: default;
    }
    .head { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #3ddc97; flex: none; margin-right: 2px; }
    .paused .dot { background: #8a8f98; }
    .title { flex: 1; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .btn {
      all: unset; cursor: pointer; width: 18px; height: 18px; line-height: 18px; flex: none;
      text-align: center; border-radius: 4px; color: #9aa0a8; font: 14px/18px system-ui, sans-serif;
    }
    .btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
    .body { margin-top: 6px; display: grid; gap: 3px; }
    .row { display: grid; grid-template-columns: 72px 1fr; gap: 8px; }
    .k { color: #8a8f98; }
    .v { color: #f2f2f2; overflow-wrap: anywhere; }
    .sub { display: block; color: #7d8590; font-size: 10px; }
    .badge {
      display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px;
      background: #f5c542; color: #111; font-size: 9.5px; font-weight: 700; vertical-align: 1px;
    }
    canvas { display: block; width: 100%; height: 34px; margin-top: 6px; }
    .collapsed { width: auto; max-width: 300px; padding-bottom: 6px; }
    .collapsed .body, .collapsed canvas { display: none; }
  `;
  let sheet = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function makeOverlay(st) {
    const host = document.createElement('stream-inspector-overlay');
    ownHosts.add(host);
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;display:none;';
    const root = host.attachShadow({ mode: 'closed' });
    // Constructable stylesheets aren't blocked by strict page CSPs the way an
    // inline <style> can be, and we never touch innerHTML (Trusted Types).
    if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); }
    root.adoptedStyleSheets = [sheet];

    const panel = el('div', 'panel');
    const head = el('div', 'head');
    const title = el('span', 'title');
    const min = el('button', 'btn', '–');
    const close = el('button', 'btn', '×');
    min.title = 'Collapse';
    close.title = 'Hide for this video';
    head.append(el('span', 'dot'), title, min, close);
    const body = el('div', 'body');
    const canvas = el('canvas');
    canvas.title = 'Video bitrate, last 60 s';
    panel.append(head, body, canvas);
    root.append(panel);

    // Keep clicks from reaching the player (e.g. in fullscreen, where the
    // overlay lives inside the player's container).
    for (const t of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']) {
      panel.addEventListener(t, e => e.stopPropagation());
    }
    const toggle = () => { st.collapsed = !st.collapsed; fill(st); };
    head.addEventListener('click', toggle);
    min.addEventListener('click', e => { e.stopPropagation(); toggle(); });
    close.addEventListener('click', e => {
      e.stopPropagation();
      st.dismissed = true;
      host.style.display = 'none';
    });
    return { host, panel, title, body, canvas, min };
  }

  function drawSpark(canvas, hist) {
    // The panel is CSS-zoomed by the size setting; draw at that resolution.
    const dpr = (window.devicePixelRatio || 1) * scale;
    const w = Math.round(282 * dpr), h = Math.round(34 * dpr);
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (hist.length < 2) return;
    const max = Math.max(...hist) * 1.15;
    const step = w / 59;
    const x0 = w - (hist.length - 1) * step;
    const y = val => h - (val / max) * (h - 2 * dpr) - dpr;
    ctx.beginPath();
    ctx.moveTo(x0, h);
    hist.forEach((val, i) => ctx.lineTo(x0 + i * step, y(val)));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(79, 209, 197, 0.16)';
    ctx.fill();
    ctx.beginPath();
    hist.forEach((val, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x0 + i * step, y(val)));
    ctx.strokeStyle = '#4fd1c5';
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    ctx.fillStyle = '#7d8590';
    ctx.font = `${10 * dpr}px ui-monospace, Consolas, monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText(fmtBps(max / 1.15), 2 * dpr, 1 * dpr);
  }

  function fill(st) {
    const o = st.overlay, s = st.stats;
    if (!o || !s) return;
    o.title.textContent = s.summary;
    o.panel.style.zoom = String(scale);
    o.panel.classList.toggle('collapsed', st.collapsed);
    o.panel.classList.toggle('paused', !!st.paused);
    o.min.textContent = st.collapsed ? '+' : '–';
    if (st.collapsed) return;
    o.body.replaceChildren(...s.rows.map(row => {
      const r = el('div', 'row');
      const val = el('span', 'v');
      val.append(document.createTextNode(row.v));
      if (row.badge) val.append(el('span', 'badge', row.badge));
      if (row.sub) val.append(el('span', 'sub', row.sub));
      r.append(el('span', 'k', row.k), val);
      return r;
    }));
    drawSpark(o.canvas, st.hist);
  }

  // Settings (see bridge.js / shared.js for the defaults).
  let enabled = false;
  let scale = 1;
  let collapsedDefault = false;
  const active = new Set(); // videos that currently own an overlay

  function render(vids) {
    const alive = new Set(vids);
    for (const v of active) {
      if (alive.has(v)) continue;
      const st = states.get(v);
      if (st && st.overlay) { st.overlay.host.remove(); st.overlay = null; }
      active.delete(v);
    }
    for (const v of vids) {
      const st = states.get(v);
      st.show = enabled && !st.dismissed && !!st.stats && v.readyState > 0;
      if (!st.show) continue;
      if (!st.overlay) { st.overlay = makeOverlay(st); active.add(v); }
      fill(st);
    }
    position();
  }

  function position() {
    if (!active.size) return;
    const fs = document.fullscreenElement;
    const container = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    const vw = innerWidth, vh = innerHeight;
    for (const v of active) {
      const st = states.get(v);
      const o = st && st.overlay;
      if (!o) continue;
      let visible = st.show;
      if (visible && fs && !fs.contains(v)) visible = false;
      let r;
      if (visible) {
        r = v.getBoundingClientRect();
        visible = r.width >= 240 && r.height >= 135 && r.bottom > 40 && r.top < vh - 40 && r.right > 40 && r.left < vw - 40;
      }
      if (!visible) { o.host.style.display = 'none'; continue; }
      if (o.host.parentNode !== container) container.appendChild(o.host);
      const x = Math.min(Math.max(4, r.left + 8), vw - 120 * scale);
      const y = Math.min(Math.max(4, r.top + 8), vh - 40);
      o.host.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      o.host.style.display = 'block';
    }
  }

  let posQueued = false;
  const queuePosition = () => {
    if (posQueued || !active.size) return;
    posQueued = true;
    requestAnimationFrame(() => { posQueued = false; safe(position); });
  };
  addEventListener('scroll', queuePosition, { capture: true, passive: true });
  addEventListener('resize', queuePosition, { passive: true });
  document.addEventListener('fullscreenchange', () => safe(position));

  // ------------------------------------------------------------ main loop

  function tick() {
    const vids = safe(findVideos, []);
    for (const v of vids) {
      const st = stateFor(v);
      st.paused = v.paused;
      safe(() => sample(v, st));
      st.stats = safe(() => computeStats(v, st), st.stats);
    }
    safe(pollRtc);
    safe(() => render(vids));
  }
  setInterval(tick, 1000);
  setInterval(() => safe(position), 250);

  // Settings arrive from bridge.js (isolated world, has chrome.storage).
  document.addEventListener('__stream_inspector_cfg', e => {
    const cfg = safe(() => JSON.parse(e.detail), null);
    if (!cfg) return;
    const was = enabled;
    enabled = !!cfg.overlay;
    scale = Math.min(Math.max(Number(cfg.scale) || 1, 0.5), 3);
    const vids = safe(findVideos, []);
    if (enabled && !was) {
      // Turning the overlay back on also restores panels closed with ×.
      vids.forEach(v => { const st = states.get(v); if (st) st.dismissed = false; });
    }
    if (!!cfg.collapsed !== collapsedDefault) {
      collapsedDefault = !!cfg.collapsed;
      vids.forEach(v => { const st = states.get(v); if (st) st.collapsed = collapsedDefault; });
    }
    tick();
  });
  document.dispatchEvent(new CustomEvent('__stream_inspector_ready'));

  // Read by the popup via chrome.scripting.executeScript({ world: 'MAIN' }).
  function snapshot() {
    return safe(findVideos, []).map(v => {
      const st = states.get(v);
      if (!st || !st.stats || v.readyState === 0) return null;
      const r = v.getBoundingClientRect();
      return {
        summary: st.stats.summary,
        rows: st.stats.rows,
        hist: st.hist.slice(),
        area: r.width * r.height,
        paused: v.paused,
        frame: location.hostname,
      };
    }).filter(Boolean);
  }

  safe(() => Object.defineProperty(window, '__streamInspector', {
    value: Object.freeze({ snapshot }),
    enumerable: false,
  }));
})();
