// Copies the MediaPipe Tasks Vision WASM runtime and the short-range face
// detector model into public/mediapipe/, so the vision worker loads them from
// our own origin. The default CDN and model host are cross-origin fetches that
// COEP (`require-corp`, SPEC §14) must not depend on.
// Runs before `dev` and `build` (see package.json); public/mediapipe is gitignored.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WASM_SRC = join('node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_DST = join('public', 'mediapipe', 'wasm');
const MODEL_SRC = join('node_modules', '@mediapipe', 'face_detection', 'face_detection_short_range.tflite');
const MODEL_DST = join('public', 'mediapipe', 'face_detection_short_range.tflite');

if (!existsSync(WASM_SRC) || !existsSync(MODEL_SRC)) {
  console.error('copy-mediapipe: missing @mediapipe packages or model — run npm install first');
  process.exit(1);
}
mkdirSync(WASM_DST, { recursive: true });
const wasmFiles = readdirSync(WASM_SRC).filter((f) => f.endsWith('.js') || f.endsWith('.wasm'));
for (const f of wasmFiles) copyFileSync(join(WASM_SRC, f), join(WASM_DST, f));
copyFileSync(MODEL_SRC, MODEL_DST);
console.log(`copy-mediapipe: ${wasmFiles.length} wasm files + model → public/mediapipe`);
