import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};

const WORKER_ENTRY = 'src/tracking/tracker.worker.ts';
const WORKER_OUT = 'public/mediapipe/tracker-worker.js';

/**
 * Pre-bundles the tracking worker into a single classic (IIFE) script.
 *
 * MediaPipe's WASM loader pulls in vision_wasm_internal.js with
 * importScripts() and expects it to assign ModuleFactory onto the worker
 * global. An ES module worker has neither importScripts nor a shared global,
 * so it dies with "ModuleFactory not set" — which the tracker absorbs by
 * silently falling back to main-thread inference.
 *
 * Vite's `worker.format: 'iife'` only applies to `vite build`; the dev server
 * always emits `new Worker(url, { type: 'module' })`. Bundling the worker
 * ourselves is what makes dev and production behave the same.
 */
function buildTrackingWorker(): Plugin {
  let root = process.cwd();

  const compile = () =>
    esbuild({
      entryPoints: [path.join(root, WORKER_ENTRY)],
      outfile: path.join(root, WORKER_OUT),
      bundle: true,
      format: 'iife',
      target: 'es2022',
      platform: 'browser',
      minify: true,
      logLevel: 'silent',
      // IIFE output has no import.meta; nothing in this graph needs it, but the
      // MediaPipe bundle references it for its own asset resolution.
      define: { 'import.meta.url': 'self.location.href' },
    });

  return {
    name: 'build-tracking-worker',
    configResolved(config) {
      root = config.root;
    },
    async buildStart() {
      await compile();
    },
    async configureServer(server) {
      await compile();
      // The worker sits outside Vite's module graph, so nothing else would
      // rebuild it when its sources change.
      server.watcher.add(path.join(root, 'src/tracking'));
      server.watcher.on('change', (file) => {
        if (file.includes(`${path.sep}src${path.sep}tracking${path.sep}`)) void compile();
      });
    },
  };
}

/**
 * MediaPipe loads its runtime by importing `<wasmPath>/vision_wasm_internal.js`
 * at runtime. In dev, Vite's transform middleware claims that request first and
 * rejects it, because the file lives in `public/` and is therefore not part of
 * the module graph. This middleware runs ahead of Vite's and streams those
 * files straight from disk. Production is unaffected — `vite build` copies
 * `public/` verbatim.
 */
function serveMediapipeRuntime(): Plugin {
  return {
    name: 'serve-mediapipe-runtime',
    configureServer(server) {
      // Registering here (rather than in the returned post-hook) puts us ahead
      // of Vite's own middlewares.
      server.middlewares.use('/mediapipe', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        // Refuse anything trying to climb out of the runtime directory.
        if (rel.includes('..')) {
          next();
          return;
        }
        const file = path.join(server.config.publicDir, 'mediapipe', rel);
        stat(file)
          .then((s) => {
            if (!s.isFile()) {
              next();
              return;
            }
            res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
            res.setHeader('Content-Length', s.size);
            createReadStream(file).pipe(res);
          })
          .catch(() => next());
      });
    },
  };
}

export default defineConfig({
  plugins: [buildTrackingWorker(), serveMediapipeRuntime()],
  server: {
    port: 5173,
    // getUserMedia needs a secure context; localhost counts, so plain http is fine.
    host: 'localhost',
  },
  build: {
    target: 'es2022',
    // The MediaPipe bundle is large by nature — don't nag about it.
    chunkSizeWarningLimit: 2000,
  },
});
