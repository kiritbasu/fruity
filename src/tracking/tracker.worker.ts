/// <reference lib="webworker" />
import { InferenceEngine } from './engine';
import type { WorkerRequest, WorkerResponse } from './types';

const engine = new InferenceEngine();
let ready = false;

const post = (msg: WorkerResponse) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;

  switch (msg.type) {
    case 'init':
      try {
        await engine.init(msg);
        ready = true;
        post({ type: 'ready', delegate: engine.delegate });
      } catch (err) {
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      break;

    case 'frame': {
      if (!ready) {
        msg.bitmap.close();
        return;
      }
      try {
        const frame = engine.detect(msg.bitmap, msg.timestamp);
        post({ type: 'result', frame });
      } catch (err) {
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        // Bitmaps are transferred in; the worker owns and must release them.
        msg.bitmap.close();
      }
      break;
    }

    case 'close':
      engine.close();
      ready = false;
      self.close();
      break;
  }
};
