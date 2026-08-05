import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';
import { classifyHand, createPoseMemory, type PoseMemory } from './gestures';
import type { HandSample, Landmark, TrackerFrame } from './types';

export interface EngineOptions {
  wasmPath: string;
  modelPath: string;
  numHands: number;
  delegate: 'GPU' | 'CPU';
}

/**
 * Wraps MediaPipe GestureRecognizer. Lives in its own module so it can run
 * either inside the tracking worker (normal path) or on the main thread
 * (fallback when workers or OffscreenCanvas are unavailable).
 */
export class InferenceEngine {
  private recognizer: GestureRecognizer | null = null;
  private memories: PoseMemory[] = [];
  private lastTimestamp = -1;
  delegate: 'GPU' | 'CPU' = 'CPU';

  async init(opts: EngineOptions): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(opts.wasmPath);

    const build = (delegate: 'GPU' | 'CPU') =>
      GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: opts.modelPath, delegate },
        runningMode: 'VIDEO',
        numHands: opts.numHands,
        // Detection is the expensive stage; a higher bar means fewer redetects
        // once tracking has locked on. Tracking confidence stays low so the
        // lock survives fast swipes and motion blur.
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.35,
      });

    try {
      this.recognizer = await build(opts.delegate);
      this.delegate = opts.delegate;
    } catch (err) {
      if (opts.delegate === 'CPU') throw err;
      // Integrated GPUs on older Macs sometimes fail WebGL context creation
      // inside a worker. CPU inference is only marginally slower on 0.10.3x.
      console.warn('[tracker] GPU delegate unavailable, falling back to CPU', err);
      this.recognizer = await build('CPU');
      this.delegate = 'CPU';
    }

    await this.warmUp();
  }

  /**
   * The first real inference costs several seconds — graph construction, WASM
   * warmup and GPU shader compilation all land on it. Paying that here means
   * it happens behind the loading screen rather than on the player's first
   * swipe. Timestamp 0 keeps the monotonic counter below any real frame.
   */
  private async warmUp(): Promise<void> {
    try {
      // Several passes, not one: the first compiles the graph, and the next
      // couple settle the GPU shader cache. One pass leaves a ~190ms spike on
      // the player's first real frame.
      for (let i = 0; i < 3; i++) {
        const blank = await createImageBitmap(new ImageData(320, 240));
        this.recognizer!.recognizeForVideo(blank, i);
        blank.close();
      }
      this.lastTimestamp = 2;
    } catch (err) {
      console.warn('[tracker] warm-up skipped', err);
    }
  }

  detect(image: ImageBitmap | HTMLVideoElement, timestamp: number): TrackerFrame {
    if (!this.recognizer) throw new Error('Engine not initialized');

    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const ts = timestamp <= this.lastTimestamp ? this.lastTimestamp + 1 : timestamp;
    this.lastTimestamp = ts;

    const t0 = performance.now();
    const result = this.recognizer.recognizeForVideo(image, ts);
    const inferenceMs = performance.now() - t0;

    const hands: HandSample[] = [];
    for (let i = 0; i < result.landmarks.length; i++) {
      const lm = result.landmarks[i] as Landmark[];
      if (!lm || lm.length < 21) continue;

      if (!this.memories[i]) this.memories[i] = createPoseMemory();
      const canned = result.gestures?.[i]?.[0];
      const hand = classifyHand(lm, canned?.categoryName, canned?.score ?? 0, this.memories[i]);

      const handed = result.handedness?.[i]?.[0]?.categoryName;
      // MediaPipe labels handedness from the camera's point of view; the game
      // shows a mirrored selfie view, so the label flips for the player.
      hand.handedness = handed === 'Left' ? 'Right' : 'Left';
      hands.push(hand);
    }

    return { hands, timestamp, inferenceMs };
  }

  close() {
    this.recognizer?.close();
    this.recognizer = null;
  }
}
