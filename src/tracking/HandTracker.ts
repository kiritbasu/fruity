import { InferenceEngine } from './engine';
import { OneEuroVec2 } from './oneEuro';
import type {
  HandSample,
  InputSource,
  ScreenHand,
  TrackerFrame,
  TrackerStats,
  WorkerRequest,
  WorkerResponse,
} from './types';
import { clamp } from '../util/math';

export type { ScreenHand, TrackerStats } from './types';

const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_PATH = `${import.meta.env.BASE_URL}models/gesture_recognizer.task`;
/**
 * Pre-bundled as a classic script by the buildTrackingWorker plugin. It has to
 * be a classic worker: MediaPipe's WASM loader needs importScripts and a shared
 * global, neither of which an ES module worker provides.
 */
const WORKER_PATH = `${import.meta.env.BASE_URL}mediapipe/tracker-worker.js`;

/** Camera resolution requested from getUserMedia. */
const CAM_W = 640;
const CAM_H = 480;
/**
 * Resolution actually handed to MediaPipe. The detector rescales to 192px
 * internally anyway, so anything above ~320px is pure copy cost — and on a
 * 2019 Intel Mac that copy is a measurable slice of the frame budget.
 */
const INFER_W = 320;
const INFER_H = 240;

/**
 * Floor and ceiling on how far we extrapolate past the newest sample. The
 * actual cap scales with the tracker's period: the slower inference runs, the
 * older the newest sample is, and the further ahead we have to project to keep
 * the sword under the player's hand.
 */
const LEAD_MIN = 0.05;
const LEAD_MAX = 0.13;

interface HandTrack {
  filter: OneEuroVec2;
  pinchFilter: OneEuroVec2;
  /** Last two smoothed samples, for velocity + extrapolation. */
  prev: { x: number; y: number; t: number } | null;
  last: { x: number; y: number; t: number } | null;
  sample: HandSample | null;
  lastSeen: number;
  screenPrev: { x: number; y: number } | null;
  wasPinching: boolean;
  /** Smoothed pointing direction in screen space (already mirrored). */
  dirX: number;
  dirY: number;
}

export class HandTracker implements InputSource {
  readonly video = document.createElement('video');

  private worker: Worker | null = null;
  private engine: InferenceEngine | null = null;
  private stream: MediaStream | null = null;

  private tracks = new Map<string, HandTrack>();
  private running = false;
  private busy = false;
  private lastSendAt = 0;
  private rvfcHandle = 0;
  private pumpTimer = 0;

  /** Adaptive: drops when inference is slow so the render loop keeps its budget. */
  private targetHz = 30;
  private smoothedInferenceMs = 0;
  private sampleTimes: number[] = [];
  /** Measured interval between camera frames; the real ceiling on sample rate. */
  private cameraPeriod = 1000 / 30;
  private lastRvfc = 0;

  private _mode: 'worker' | 'main' = 'worker';
  private _delegate: 'GPU' | 'CPU' | '—' = '—';

  constructor(private numHands = 1) {
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  /** The live camera stream, so multiplayer can reuse it for a video track. */
  get cameraStream(): MediaStream | null {
    return this.stream;
  }

  async start(): Promise<void> {
    await this.openCamera();
    try {
      await this.startWorker();
    } catch (err) {
      console.warn('[tracker] worker path failed, running inference on main thread', err);
      await this.startMainThread();
    }
    this.running = true;
    this.pump();
  }

  private async openCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser has no camera API. Try Chrome, Edge, Firefox or Safari 16+.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: CAM_W },
        height: { ideal: CAM_H },
        /*
         * Ask for 60 and take whatever the camera gives. The sample rate is
         * still governed below, but a 60fps sensor halves how stale each
         * sampled frame is before inference even starts — roughly 8ms off
         * end-to-end latency for free on cameras that support it.
         */
        frameRate: { ideal: 60 },
        facingMode: 'user',
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    // Safari occasionally reports 0×0 for a frame or two after play() resolves.
    if (!this.video.videoWidth) {
      await new Promise<void>((resolve) => {
        this.video.addEventListener('loadeddata', () => resolve(), { once: true });
      });
    }
  }

  private startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(WORKER_PATH);
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(new Error('Tracking worker timed out during init'));
      }, 25_000);

      worker.onerror = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(e.message || 'Worker error'));
      };

      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.worker = worker;
          this._mode = 'worker';
          this._delegate = msg.delegate;
          resolve();
        } else if (msg.type === 'result') {
          this.busy = false;
          this.ingest(msg.frame);
        } else if (msg.type === 'error') {
          this.busy = false;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(msg.message));
          } else {
            console.warn('[tracker]', msg.message);
          }
        }
      };

      const req: WorkerRequest = {
        type: 'init',
        wasmPath: WASM_PATH,
        modelPath: MODEL_PATH,
        numHands: this.numHands,
        delegate: 'GPU',
      };
      worker.postMessage(req);
    });
  }

  private async startMainThread(): Promise<void> {
    const engine = new InferenceEngine();
    await engine.init({
      wasmPath: WASM_PATH,
      modelPath: MODEL_PATH,
      numHands: this.numHands,
      delegate: 'GPU',
    });
    this.engine = engine;
    this._mode = 'main';
    this._delegate = engine.delegate;
    // Without a worker, inference competes with rendering — ask for less of it.
    this.targetHz = 24;
  }

  /**
   * Drives capture. Uses requestVideoFrameCallback where available so we only
   * ever run inference on genuinely new camera frames rather than resampling
   * the same one at display rate.
   */
  private pump = () => {
    if (!this.running) return;

    const hasRvfc = 'requestVideoFrameCallback' in this.video;
    if (hasRvfc) {
      this.rvfcHandle = this.video.requestVideoFrameCallback(() => {
        const now = performance.now();
        if (this.lastRvfc) {
          const delta = now - this.lastRvfc;
          // Ignore absurd gaps from tab throttling.
          if (delta > 5 && delta < 200) this.cameraPeriod = this.cameraPeriod * 0.85 + delta * 0.15;
        }
        this.lastRvfc = now;
        void this.maybeSend();
        this.pump();
      });
    } else {
      this.pumpTimer = window.setTimeout(() => {
        void this.maybeSend();
        this.pump();
      }, 1000 / 30);
    }
  };

  private async maybeSend(): Promise<void> {
    const now = performance.now();
    // Watchdog: a reply that never arrives would otherwise wedge the tracker
    // permanently, which looks exactly like "it stopped seeing my hand".
    if (this.busy && now - this.lastSendAt > 1200) this.busy = false;
    if (this.busy || !this.running) return;

    /*
     * New frames only arrive at the camera's rate, so a minimum interval longer
     * than one camera period quantises the real sample rate to cameraRate / n:
     * asking for 24Hz off a 30Hz camera actually yields 15Hz, and asking for
     * 13Hz yields 10Hz. Allowing a send up to half a camera frame early makes
     * us land on the nearest achievable rate instead of the next one down.
     */
    const interval = 1000 / this.targetHz;
    if (now - this.lastSendAt < interval - this.cameraPeriod * 0.5) return;
    if (!this.video.videoWidth) return;

    this.busy = true;
    this.lastSendAt = now;

    try {
      if (this.worker) {
        const bitmap = await this.grabBitmap();
        if (!bitmap) {
          this.busy = false;
          return;
        }
        const req: WorkerRequest = { type: 'frame', bitmap, timestamp: now };
        this.worker.postMessage(req, [bitmap]);
      } else if (this.engine) {
        // Main-thread path feeds the video element directly; MediaPipe does
        // its own downscale and we skip a bitmap allocation per frame.
        const frame = this.engine.detect(this.video, now);
        this.busy = false;
        this.ingest(frame);
      } else {
        this.busy = false;
      }
    } catch (err) {
      this.busy = false;
      console.warn('[tracker] frame dropped', err);
    }
  }

  private async grabBitmap(): Promise<ImageBitmap | null> {
    try {
      return await createImageBitmap(this.video, {
        resizeWidth: INFER_W,
        resizeHeight: INFER_H,
        resizeQuality: 'low',
      });
    } catch {
      try {
        return await createImageBitmap(this.video);
      } catch {
        return null;
      }
    }
  }

  private ingest(frame: TrackerFrame): void {
    this.smoothedInferenceMs = this.smoothedInferenceMs * 0.85 + frame.inferenceMs * 0.15;

    this.sampleTimes.push(frame.timestamp);
    if (this.sampleTimes.length > 30) this.sampleTimes.shift();

    this.adaptRate();

    const now = frame.timestamp;
    for (let i = 0; i < frame.hands.length; i++) {
      const hand = frame.hands[i];
      const id = this.numHands > 1 ? hand.handedness : 'primary';
      let track = this.tracks.get(id);
      if (!track) {
        track = {
          // High beta is deliberate: it all but disables smoothing once the
          // hand is moving, which is exactly when lag is felt. The cost is
          // slightly jitterier tracking at rest, which nobody notices.
          filter: new OneEuroVec2(2.0, 0.45),
          pinchFilter: new OneEuroVec2(2.5, 0.01),
          prev: null,
          last: null,
          sample: null,
          lastSeen: now,
          screenPrev: null,
          wasPinching: false,
          dirX: 0,
          dirY: -1,
        };
        this.tracks.set(id, track);
      }

      // A hand that vanished and came back shouldn't drag a stale trail with it.
      if (now - track.lastSeen > 350) {
        track.filter.reset();
        track.prev = null;
        track.last = null;
        track.screenPrev = null;
      }

      const s = track.filter.filter(hand.x, hand.y, now);
      track.prev = track.last;
      track.last = { x: s.x, y: s.y, t: now };
      track.sample = hand;
      track.lastSeen = now;

      // Smooth the direction as a vector rather than an angle — no wrap-around
      // to unpick, and it degrades gracefully when the hand faces the camera
      // and the projected direction gets short. Mirrored to match screen space.
      const tx = -hand.dirX;
      const ty = hand.dirY;
      const mag = Math.hypot(tx, ty);
      if (mag > 0.15) {
        const k = 0.32;
        track.dirX += (tx / mag - track.dirX) * k;
        track.dirY += (ty / mag - track.dirY) * k;
        const m2 = Math.hypot(track.dirX, track.dirY) || 1;
        track.dirX /= m2;
        track.dirY /= m2;
      }
    }

    // Forget hands that have been gone for a while.
    for (const [id, track] of this.tracks) {
      if (now - track.lastSeen > 1000) this.tracks.delete(id);
    }
  }

  /**
   * Keeps the tracker inside its share of the frame budget. On a slow machine
   * a fixed 24Hz would starve rendering; better to track at 15Hz smoothly than
   * stutter at 24.
   */
  private adaptRate(): void {
    const ms = this.smoothedInferenceMs;
    // Inference budget per frame. In a worker it competes only with itself; on
    // the main thread it is stealing directly from the render loop.
    const budget = this._mode === 'worker' ? 26 : 18;
    // Inference off the main thread runs ~13ms, so a fast machine with a 60fps
    // camera can afford more than 30 samples a second. The governor below pulls
    // this straight back down on hardware that cannot.
    const max = this._mode === 'worker' ? 45 : 24;
    /*
     * The recover threshold has to sit just under the throttle threshold. An
     * earlier version throttled above 22ms but only recovered below 12ms, which
     * left a dead band: once anything (a slow first frame, a GC pause) knocked
     * the rate down, a perfectly healthy 14ms inference could never climb back.
     */
    if (ms > budget) {
      this.targetHz = Math.max(10, this.targetHz - 0.4);
    } else if (ms < budget * 0.85) {
      this.targetHz = Math.min(max, this.targetHz + 0.5);
    }
  }

  /**
   * Returns hands in screen space for the given render time. Positions are
   * extrapolated from the newest sample so a 60Hz swipe feels continuous even
   * though inference only lands ~24 times a second.
   */
  getHands(nowMs: number, width: number, height: number): ScreenHand[] {
    const out: ScreenHand[] = [];

    for (const [id, track] of this.tracks) {
      const { last, sample } = track;
      if (!last || !sample) continue;
      if (nowMs - track.lastSeen > 400) {
        track.screenPrev = null;
        continue;
      }

      let nx = last.x;
      let ny = last.y;
      let vnx = 0;
      let vny = 0;

      if (track.prev) {
        const dt = (last.t - track.prev.t) / 1000;
        if (dt > 1e-3) {
          vnx = (last.x - track.prev.x) / dt;
          vny = (last.y - track.prev.y) / dt;
          // One tracker period of lead, bounded so a stall can't fling the
          // sword off screen.
          const cap = clamp(dt * 1.1, LEAD_MIN, LEAD_MAX);
          const lead = clamp((nowMs - last.t) / 1000, 0, cap);
          nx += vnx * lead;
          ny += vny * lead;
        }
      }

      // Camera is shown mirrored (selfie view), so x flips into screen space.
      const x = (1 - clamp(nx, -0.2, 1.2)) * width;
      const y = clamp(ny, -0.2, 1.2) * height;
      const prev = track.screenPrev ?? { x, y };

      const pinching = sample.pose === 'pinch';
      const pinchStarted = pinching && !track.wasPinching;
      track.wasPinching = pinching;

      out.push({
        id,
        x,
        y,
        prevX: prev.x,
        prevY: prev.y,
        vx: -vnx * width,
        vy: vny * height,
        speed: Math.hypot(-vnx * width, vny * height),
        pose: sample.pose,
        pinchStarted,
        pinchStrength: sample.pinchStrength,
        // 0.9 palm-widths reads as a fair "hand-sized" hit volume in play.
        radius: clamp(sample.palmSize * width * 0.9, 26, 150),
        dirX: track.dirX,
        dirY: track.dirY,
        handedness: sample.handedness,
        thumbTip: { x: (1 - sample.thumbTip.x) * width, y: sample.thumbTip.y * height },
        indexTip: { x: (1 - sample.indexTip.x) * width, y: sample.indexTip.y * height },
      });

      track.screenPrev = { x, y };
      void id;
    }

    return out;
  }

  get stats(): TrackerStats {
    let hz = 0;
    if (this.sampleTimes.length > 2) {
      const span = this.sampleTimes[this.sampleTimes.length - 1] - this.sampleTimes[0];
      if (span > 0) hz = ((this.sampleTimes.length - 1) / span) * 1000;
    }
    return {
      inferenceMs: this.smoothedInferenceMs,
      trackerHz: hz,
      targetHz: this.targetHz,
      cameraHz: 1000 / this.cameraPeriod,
      delegate: this._delegate,
      mode: this._mode,
      handsVisible: this.tracks.size,
    };
  }

  stop(): void {
    this.running = false;
    if (this.rvfcHandle && 'cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    clearTimeout(this.pumpTimer);
    this.worker?.postMessage({ type: 'close' } satisfies WorkerRequest);
    this.worker = null;
    this.engine?.close();
    this.engine = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
