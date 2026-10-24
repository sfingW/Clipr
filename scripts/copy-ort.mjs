// Copies the ONNX Runtime WASM loader + binary (threaded SIMD, CPU) that
// Transformers.js needs into public/ort/, so the browser fetches them from our
// own origin. The library default is a jsDelivr CDN URL, which is a
// cross-origin fetch that COEP (`require-corp`, SPEC §14) must not depend on.
// Runs before `dev` and `build` (see package.json); public/ort is gitignored.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join('node_modules', 'onnxruntime-web', 'dist');
const DST = join('public', 'ort');
const FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

const missing = FILES.filter((f) => !existsSync(join(SRC, f)));
if (missing.length > 0) {
  console.error(`copy-ort: missing ${missing.join(', ')} in ${SRC} — run npm install first`);
  process.exit(1);
}
mkdirSync(DST, { recursive: true });
for (const f of FILES) copyFileSync(join(SRC, f), join(DST, f));
console.log(`copy-ort: ${FILES.length} files → ${DST}`);
