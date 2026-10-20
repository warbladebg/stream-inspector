// Reads codecs out of MP4 / WebM container headers.
// - parse(bytes): used in the page on MSE init segments, which always describe
//   the quality level actually being played.
// - sniffFile(url): used by the background worker for plain video files (it
//   isn't bound by CORS). Only codec strings leave it, never raw bytes, so a
//   page can't use it to read other sites.
(() => {
  if (self.__streamInspectorSniff) return;
  const hex2 = n => n.toString(16).padStart(2, '0');

  function findBytes(buf, str, from = 0) {
    const a = str.charCodeAt(0);
    outer: for (let i = from; i <= buf.length - str.length; i++) {
      if (buf[i] !== a) continue;
      for (let j = 1; j < str.length; j++) if (buf[i + j] !== str.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }

  // ES_Descriptor -> DecoderConfigDescriptor (object type) -> DecoderSpecificInfo
  // (AudioSpecificConfig, whose first 5 bits are the audio object type).
  function esdsCodec(buf, p) {
    const skipLen = () => { while (buf[p] & 0x80) p++; p++; };
    if (buf[p++] !== 0x03) return null;
    skipLen();
    const flags = buf[p + 2];
    p += 3;
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + buf[p];
    if (flags & 0x20) p += 2;
    if (buf[p++] !== 0x04) return null;
    skipLen();
    const oti = buf[p];
    p += 13;
    if (oti !== 0x40 || buf[p++] !== 0x05) return `mp4a.${hex2(oti)}`;
    skipLen();
    let aot = buf[p] >> 3;
    if (aot === 31) aot = 32 + (((buf[p] & 7) << 3) | (buf[p + 1] >> 5));
    return `mp4a.40.${aot}`;
  }

  function sniffMp4(buf) {
    const out = [];
    for (let i = findBytes(buf, 'stsd'); i !== -1; i = findBytes(buf, 'stsd', i + 4)) {
      // stsd: type(4) version/flags(4) entry_count(4), then entry size(4) + fourcc(4)
      let fourcc = String.fromCharCode(...buf.subarray(i + 16, i + 20));
      if (!/^[a-z0-9-]{4}$/i.test(fourcc)) continue;
      if (fourcc === 'encv' || fourcc === 'enca') {
        // Encrypted (DRM) entry: the real format is in sinf/frma.
        const f = findBytes(buf, 'frma', i);
        if (f === -1 || f > i + 600) continue;
        fourcc = String.fromCharCode(...buf.subarray(f + 4, f + 8));
      }
      let codec = fourcc;
      if (fourcc === 'avc1' || fourcc === 'avc3') {
        const c = findBytes(buf, 'avcC', i);
        if (c !== -1 && c < i + 400) codec = `${fourcc}.${hex2(buf[c + 5])}${hex2(buf[c + 6])}${hex2(buf[c + 7])}`;
      } else if (fourcc === 'hvc1' || fourcc === 'hev1') {
        // hvcC: version, then profile_space(2) tier(1) profile_idc(5), 4 bytes of
        // compatibility flags, 6 bytes of constraint flags, level_idc
        const c = findBytes(buf, 'hvcC', i);
        if (c !== -1 && c < i + 400) {
          const b = buf[c + 5];
          codec = `${fourcc}.${b & 0x1f}.0.${b & 0x20 ? 'H' : 'L'}${buf[c + 16]}`;
        }
      } else if (fourcc === 'av01') {
        // av1C: marker/version, seq_profile(3) seq_level_idx(5), tier(1) high_bitdepth(1) twelve_bit(1)
        const c = findBytes(buf, 'av1C', i);
        if (c !== -1 && c < i + 400) {
          const b1 = buf[c + 5], b2 = buf[c + 6];
          const depth = b2 & 0x40 ? (b2 & 0x20 ? 12 : 10) : 8;
          codec = `av01.${b1 >> 5}.${String(b1 & 0x1f).padStart(2, '0')}${b2 & 0x80 ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
        }
      } else if (fourcc === 'vp09') {
        // vpcC (full box): profile, level, bitDepth(4) chroma(3) range(1), primaries, transfer
        const c = findBytes(buf, 'vpcC', i);
        if (c !== -1 && c < i + 400) {
          const p = c + 8;
          const two = n => String(n).padStart(2, '0');
          codec = `vp09.${two(buf[p])}.${two(buf[p + 1])}.${two(buf[p + 2] >> 4)}.01.${two(buf[p + 3])}.${two(buf[p + 4])}`;
        }
      } else if (fourcc === 'mp4a') {
        const e = findBytes(buf, 'esds', i);
        let parsed = null;
        try { if (e !== -1 && e < i + 200) parsed = esdsCodec(buf, e + 8); } catch (_) {}
        codec = parsed || 'mp4a.40.2';
      }
      out.push({ codec, raw: codec });
    }
    return out;
  }

  const WEBM_CODECS = {
    V_VP8: 'vp8', V_VP9: 'vp9', V_AV1: 'av01', 'V_MPEG4/ISO/AVC': 'avc1', V_MPEGH: 'hvc1', V_THEORA: 'theora',
    A_OPUS: 'opus', A_VORBIS: 'vorbis', A_AAC: 'mp4a.40.2', A_FLAC: 'flac', A_AC3: 'ac-3', A_EAC3: 'ec-3', A_MPEG: 'mp3',
  };
  function sniffWebm(buf) {
    const out = [];
    // CodecID element: id 0x86, one-byte size (0x80 | len), ASCII string
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf[i] !== 0x86 || !(buf[i + 1] & 0x80)) continue;
      const len = buf[i + 1] & 0x7f;
      if (len < 3 || len > 24) continue;
      const id = String.fromCharCode(...buf.subarray(i + 2, i + 2 + len));
      const key = Object.keys(WEBM_CODECS).find(k => id === k || id.startsWith(k + '/'));
      if (key) out.push({ codec: WEBM_CODECS[key], raw: id });
    }
    return out;
  }

  // Read at most n bytes, then cancel, in case the server ignores Range.
  async function readUpTo(res, n) {
    const reader = res.body.getReader();
    const chunks = [];
    let len = 0;
    while (len < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      len += value.length;
    }
    reader.cancel().catch(() => {});
    const out = new Uint8Array(Math.min(len, n));
    let off = 0;
    for (const c of chunks) {
      if (off >= out.length) break;
      out.set(c.subarray(0, out.length - off), off);
      off += c.length;
    }
    return out;
  }

  const isWebm = b => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;

  function parse(buf) {
    const out = isWebm(buf) ? sniffWebm(buf) : sniffMp4(buf);
    return out.length ? out : null;
  }

  // MP4s whose index ("moov") sits at the end get a second request for the tail.
  async function sniffFile(src) {
    if (!/^https?:/i.test(src)) return null;
    const get = range => fetch(src, { headers: { Range: range }, credentials: 'include', cache: 'force-cache' });
    const res = await get('bytes=0-262143');
    if (!res.ok || !res.body) return null;
    const head = await readUpTo(res, 262144);
    if (isWebm(head)) return parse(head);
    if (findBytes(head.subarray(0, 64), 'ftyp') === -1) return null;
    let codecs = sniffMp4(head);
    if (!codecs.length) {
      const total = +((res.headers.get('content-range') || '').split('/')[1] || 0);
      if (total > head.length) {
        const tail = await get(`bytes=${Math.max(0, total - 2097152)}-${total - 1}`);
        if (tail.status === 206 && tail.body) codecs = sniffMp4(await readUpTo(tail, 2097152));
      }
    }
    return codecs.length ? codecs : null;
  }

  Object.defineProperty(self, '__streamInspectorSniff', { value: Object.freeze({ parse, sniffFile }), enumerable: false });
})();
