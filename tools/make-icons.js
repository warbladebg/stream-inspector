// Renders the extension icons (dark rounded square, teal "bitrate" bars) as PNGs.
// Usage: node tools/make-icons.js icons
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in a 0..1 unit square; 4x4 supersampling for antialiasing.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const BG = [22, 25, 31], BAR = [79, 209, 197], HI = [245, 197, 66];
const bars = [[0.20, 0.58], [0.38, 0.42], [0.56, 0.30], [0.74, 0.18]]; // [x, top]

function color(x, y) {
  if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.2)) return null;
  for (let i = 0; i < bars.length; i++) {
    const [bx, top] = bars[i];
    if (inRoundRect(x, y, bx - 0.065, top, bx + 0.065, 0.82, 0.04)) return i === bars.length - 1 ? HI : BAR;
  }
  return BG;
}

for (const size of [16, 32, 48, 128]) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = color((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (py * size + px) * 4;
    if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; buf[i + 3] = (a / (S * S)) * 255; }
  }
  fs.writeFileSync(path.join(out, `icon${size}.png`), png(size, buf));
}
console.log('ok');
