export type Pose = 'open' | 'fist' | 'pinch' | 'idle';

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** One inference result for a single hand, in normalized (0..1) camera space. */
export interface HandSample {
  /** Primary action point: palm centre for open/fist, pinch midpoint for pinch. */
  x: number;
  y: number;
  pose: Pose;
  /** 0..1 — how closed the thumb/index pinch is. */
  pinchStrength: number;
  /** Wrist→middle-MCP distance in normalized units; a depth-invariant hand scale. */
  palmSize: number;
  /** Unit vector along wrist→middle-MCP: the direction the hand points. */
  dirX: number;
  dirY: number;
  handedness: 'Left' | 'Right';
  /** Thumb tip and index tip, for drawing the pinch claw. */
  thumbTip: { x: number; y: number };
  indexTip: { x: number; y: number };
}

export interface TrackerFrame {
  hands: HandSample[];
  /** performance.now() timestamp of the frame the inference ran on. */
  timestamp: number;
  /** Milliseconds spent inside recognizeForVideo. */
  inferenceMs: number;
}

/** A hand resolved into screen space for the current render frame. */
export interface ScreenHand {
  id: string;
  x: number;
  y: number;
  /** Position at the previous render frame — the other end of the swept segment. */
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  /** Screen-space speed in px/sec. */
  speed: number;
  pose: Pose;
  /** True only on the frame the pinch closed. */
  pinchStarted: boolean;
  pinchStrength: number;
  /** Palm radius in screen px — scales hit volumes with the player's distance. */
  radius: number;
  /** Unit vector in screen space along which the sword points. */
  dirX: number;
  dirY: number;
  handedness: 'Left' | 'Right';
  thumbTip: { x: number; y: number };
  indexTip: { x: number; y: number };
}

export interface TrackerStats {
  inferenceMs: number;
  /** Measured sample rate. */
  trackerHz: number;
  /** What the pump is aiming for, and the camera's own rate. */
  targetHz: number;
  cameraHz: number;
  delegate: 'GPU' | 'CPU' | '—';
  mode: 'worker' | 'main' | 'pointer';
  handsVisible: number;
}

/**
 * Anything the game can read hands from. The camera tracker is the real one;
 * the pointer fallback implements the same shape so the game loop doesn't care
 * which is driving it.
 */
export interface InputSource {
  getHands(nowMs: number, width: number, height: number): ScreenHand[];
  readonly stats: TrackerStats;
  stop(): void;
}

export type WorkerRequest =
  | { type: 'init'; wasmPath: string; modelPath: string; numHands: number; delegate: 'GPU' | 'CPU' }
  | { type: 'frame'; bitmap: ImageBitmap; timestamp: number }
  | { type: 'close' };

export type WorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  | { type: 'result'; frame: TrackerFrame };
