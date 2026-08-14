// Baixa os woff2 (subset latin) de Inter+Montserrat do Google Fonts e gera fonts.css local.
// Uso: node scripts/fetch-fonts.mjs  (precisa de internet uma vez; depois roda offline).
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.resolve(__dirname, '..', 'public', 'fonts');
const css = readFileSync(path.join(fontsDir, 'gfonts.css'), 'utf8');

// Divide em blocos, cada @font-face precedido por um comentario de subset /* latin */.
const blocks = css.split('/*').slice(1); // cada item: " latin */ @font-face {...}"
const wanted = [];
for (const b of blocks) {
  const subset = b.slice(0, b.indexOf('*/')).trim();
  if (subset !== 'latin') continue; // latin cobre acentos PT (U+00xx)
  const fam = (b.match(/font-family:\s*'([^']+)'/) || [])[1];
  const weight = (b.match(/font-weight:\s*(\d+)/) || [])[1];
  const url = (b.match(/url\((https:[^)]+\.woff2)\)/) || [])[1];
  if (fam && weight && url) wanted.push({ fam, weight, url });
}

const get = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });

const faces = [];
for (const w of wanted) {
  const name = `${w.fam.toLowerCase()}-${w.weight}.woff2`;
  const buf = await get(w.url);
  writeFileSync(path.join(fontsDir, name), buf);
  console.log(`${name}  ${buf.length} bytes`);
  faces.push(
    `@font-face{font-family:'${w.fam}';font-style:normal;font-weight:${w.weight};` +
      `font-display:swap;src:url('${name}') format('woff2');}`,
  );
}
writeFileSync(path.join(fontsDir, 'fonts.css'), faces.join('\n') + '\n');
console.log('fonts.css gerado com', faces.length, 'faces');
