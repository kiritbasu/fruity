// Vendors the MediaPipe WASM runtime + gesture model into public/ so the game
// loads from the same origin (fast, offline-capable, no CDN version drift).
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = path.join(root, 'public', 'mediapipe', 'wasm');
const modelDst = path.join(root, 'public', 'models', 'gesture_recognizer.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

const exists = (p) => stat(p).then(() => true, () => false);

async function copyWasm() {
  if (!(await exists(wasmSrc))) {
    throw new Error(`Missing ${wasmSrc} — run "npm install" first.`);
  }
  await mkdir(path.dirname(wasmDst), { recursive: true });
  await cp(wasmSrc, wasmDst, { recursive: true });
  console.log('✓ mediapipe wasm runtime → public/mediapipe/wasm');
}

async function fetchModel() {
  if (await exists(modelDst)) {
    const { size } = await stat(modelDst);
    if (size > 1_000_000) {
      console.log('✓ gesture model already present');
      return;
    }
  }
  await mkdir(path.dirname(modelDst), { recursive: true });
  console.log('… downloading gesture_recognizer.task (~8 MB)');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(modelDst));
  console.log('✓ gesture model → public/models/gesture_recognizer.task');
}

await copyWasm();
await fetchModel();
await writeFile(path.join(root, 'public', 'mediapipe', '.gitignore'), '*\n');
