// Gera os icones do PWA a partir da logo AC (brand/ac-icone.png), compondo sobre fundo branco.
// Sem dependencias: decodifica PNG (colorType 6, 8-bit) com zlib nativo, reamostra por area e reencoda.
import zlib from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(__dirname, '..', 'public');
const outDir = path.join(pub, 'icons');
mkdirSync(outDir, { recursive: true });

// ---------- decode PNG (RGBA 8-bit, sem interlace) ----------
function decodePNG(buf) {
  let p = 8; // pula assinatura
  const idat = [];
  let width = 0,
    height = 0,
    colorType = 0,
    bitDepth = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error('PNG precisa ser RGBA 8-bit');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, data: out };
}

// flatten RGBA sobre branco -> RGB
function flattenOverWhite(img) {
  const { width, height, data } = img;
  const rgb = new Float64Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const a = data[i + 3] / 255;
    rgb[j] = data[i] * a + 255 * (1 - a);
    rgb[j + 1] = data[i + 1] * a + 255 * (1 - a);
    rgb[j + 2] = data[i + 2] * a + 255 * (1 - a);
  }
  return { width, height, rgb };
}

// reamostragem por area (box) RGB -> RGB
function resizeRGB(src, dw, dh) {
  const { width: sw, height: sh, rgb } = src;
  const out = new Float64Array(dw * dh * 3);
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor((dy * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor((dx * sw) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / dw));
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const j = (sy * sw + sx) * 3;
          r += rgb[j];
          g += rgb[j + 1];
          b += rgb[j + 2];
          n++;
        }
      }
      const o = (dy * dw + dx) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return { width: dw, height: dh, rgb: out };
}

// ---------- encode PNG (RGBA 8-bit) ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function encodePNG(px, W, H) {
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- compoe o icone ----------
const logo = flattenOverWhite(decodePNG(readFileSync(path.join(pub, 'brand', 'ac-icone.png'))));

function makeIcon(size, coverage) {
  const boxW = Math.round(size * coverage);
  const scale = boxW / logo.width;
  const lw = boxW;
  const lh = Math.round(logo.height * scale);
  const small = resizeRGB(logo, lw, lh);
  const px = Buffer.alloc(size * size * 4).fill(255); // fundo branco opaco
  const ox = Math.round((size - lw) / 2);
  const oy = Math.round((size - lh) / 2);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const s = (y * lw + x) * 3;
      const d = ((oy + y) * size + (ox + x)) * 4;
      px[d] = Math.round(small.rgb[s]);
      px[d + 1] = Math.round(small.rgb[s + 1]);
      px[d + 2] = Math.round(small.rgb[s + 2]);
      px[d + 3] = 255;
    }
  }
  return encodePNG(px, size, size);
}

// maskable pede margem de seguranca; logo cobre ~72% do quadrado, centralizado.
for (const size of [192, 512]) {
  writeFileSync(path.join(outDir, `icon-${size}.png`), makeIcon(size, 0.72));
  console.log(`icon-${size}.png gerado`);
}
// apple-touch-icon: iOS recorta em rounded-rect (nao mascara agressivo) -> cobertura maior.
// Fundo branco opaco (iOS ignora transparencia) -> aparece a logo, nao a letra "E".
writeFileSync(path.join(outDir, 'apple-touch-icon.png'), makeIcon(180, 0.8));
console.log('apple-touch-icon.png (180) gerado');
console.log('OK -> ' + outDir);
