import type { HandSample, Landmark, Pose } from './types';

// MediaPipe hand landmark indices.
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

const FINGERS: ReadonlyArray<{ tip: number; pip: number }> = [
  { tip: INDEX_TIP, pip: INDEX_PIP },
  { tip: MIDDLE_TIP, pip: MIDDLE_PIP },
  { tip: RING_TIP, pip: RING_PIP },
  { tip: PINKY_TIP, pip: PINKY_PIP },
];

const d = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Per-finger extension, measured as tip-distance-from-wrist relative to
 * PIP-distance-from-wrist. This ratio is invariant to both hand scale (depth)
 * and wrist rotation, which raw tip positions are not.
 */
function extensionRatio(lm: Landmark[], tip: number, pip: number): number {
  const pipDist = d(lm[pip], lm[WRIST]);
  if (pipDist < 1e-5) return 1;
  return d(lm[tip], lm[WRIST]) / pipDist;
}

const EXTENDED = 1.32;
const CURLED = 1.08;

/** Hysteresis state so a pose doesn't flicker on the threshold boundary. */
export interface PoseMemory {
  pinching: boolean;
  pose: Pose;
}

export function createPoseMemory(): PoseMemory {
  return { pinching: false, pose: 'idle' };
}

/**
 * Classifies a pose from landmark geometry, then lets MediaPipe's canned
 * classifier break ties. Geometry leads because it reacts a frame or two
 * sooner and degrades gracefully at odd hand angles; the canned label is a
 * corroborating vote that rescues ambiguous mid-transition frames.
 */
export function classifyHand(
  lm: Landmark[],
  cannedGesture: string | undefined,
  cannedScore: number,
  memory: PoseMemory,
): HandSample {
  const palmSize = Math.max(1e-4, d(lm[WRIST], lm[MIDDLE_MCP]));

  const ratios = FINGERS.map((f) => extensionRatio(lm, f.tip, f.pip));
  const extendedCount = ratios.filter((r) => r > EXTENDED).length;
  const curledCount = ratios.filter((r) => r < CURLED).length;
  const indexExtended = ratios[0] > 1.2;

  // Thumb/index tip gap normalized by hand scale, so it works at any depth.
  const pinchGap = d(lm[THUMB_TIP], lm[INDEX_TIP]) / palmSize;
  // Hysteresis: easy to enter a pinch, harder to leave it.
  const pinchOn = memory.pinching ? pinchGap < 0.72 : pinchGap < 0.48;
  const pinchStrength = Math.max(0, Math.min(1, (0.9 - pinchGap) / 0.55));

  // A closed fist also brings thumb and index tips together, so a pinch only
  // counts when the index finger is genuinely extended out of the palm.
  const isPinch = pinchOn && indexExtended;
  memory.pinching = isPinch;

  let pose: Pose;
  if (isPinch) {
    pose = 'pinch';
  } else if (curledCount >= 3 || (cannedGesture === 'Closed_Fist' && cannedScore > 0.6)) {
    pose = 'fist';
  } else if (extendedCount >= 3 || (cannedGesture === 'Open_Palm' && cannedScore > 0.6)) {
    pose = 'open';
  } else if (extendedCount >= 2) {
    // Two or three fingers out still reads as a slicing hand to most players.
    pose = 'open';
  } else {
    pose = 'idle';
  }
  memory.pose = pose;

  // Action point: the pinch acts at the claw's midpoint, everything else acts
  // from the palm centroid (steadier than the wrist, which swings a lot).
  let px: number;
  let py: number;
  if (pose === 'pinch') {
    px = (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2;
    py = (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2;
  } else {
    px = (lm[WRIST].x + lm[INDEX_MCP].x + lm[MIDDLE_MCP].x + lm[PINKY_MCP].x) / 4;
    py = (lm[WRIST].y + lm[INDEX_MCP].y + lm[MIDDLE_MCP].y + lm[PINKY_MCP].y) / 4;
  }

  // Direction the hand points, used to aim the sword. Wrist→middle-MCP stays
  // stable under wrist rotation and doesn't care which fingers are extended.
  const dirX = (lm[MIDDLE_MCP].x - lm[WRIST].x) / palmSize;
  const dirY = (lm[MIDDLE_MCP].y - lm[WRIST].y) / palmSize;

  return {
    x: px,
    y: py,
    pose,
    pinchStrength,
    palmSize,
    dirX,
    dirY,
    handedness: 'Right',
    thumbTip: { x: lm[THUMB_TIP].x, y: lm[THUMB_TIP].y },
    indexTip: { x: lm[INDEX_TIP].x, y: lm[INDEX_TIP].y },
  };
}
