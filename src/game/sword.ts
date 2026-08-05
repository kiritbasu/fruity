const TAU = Math.PI * 2;

interface SwordSprite {
  canvas: HTMLCanvasElement;
  /** Draw size in CSS px. */
  w: number;
  h: number;
  /** Offset from the grip point (where the hand is) to the sprite's top-left. */
  ox: number;
  oy: number;
}

const cache = new Map<string, SwordSprite>();

/** How far behind the hand the pommel sits, and how tall the guard is. */
const BACK = 0.3;
const HALF_H = 0.15;

/**
 * Bakes the sword once per size. In the local frame the blade runs along +X
 * with the grip point — where the player's hand is — at the origin.
 */
function bake(length: number, dpr: number, hot: boolean, tint?: string): SwordSprite {
  const L = length;
  const w = L * (1 + BACK);
  const h = L * HALF_H * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w * dpr));
  canvas.height = Math.max(1, Math.ceil(h * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.translate(L * BACK, L * HALF_H);

  const bw = L * 0.052; // blade half-width
  const tip = L;
  const base = L * 0.1;

  if (hot) {
    // A thin bloom hugging the edge. Anything wider swallows the blade and the
    // sword stops reading as a sword.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createLinearGradient(0, 0, tip, 0);
    glow.addColorStop(0, 'rgba(94,231,255,0)');
    glow.addColorStop(0.55, 'rgba(94,231,255,0.22)');
    glow.addColorStop(1, 'rgba(190,250,255,0.42)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(tip * 0.58, 0, tip * 0.5, bw * 1.65, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Blade: straight-sided taper to a point.
  ctx.beginPath();
  ctx.moveTo(base, -bw);
  ctx.lineTo(tip * 0.9, -bw * 0.72);
  ctx.lineTo(tip, 0);
  ctx.lineTo(tip * 0.9, bw * 0.72);
  ctx.lineTo(base, bw);
  ctx.closePath();
  const steel = ctx.createLinearGradient(0, -bw, 0, bw);
  steel.addColorStop(0, '#f4f9ff');
  steel.addColorStop(0.42, '#c3d3e6');
  steel.addColorStop(0.52, '#7d8ea6');
  steel.addColorStop(1, '#5c6b80');
  ctx.fillStyle = steel;
  ctx.fill();
  ctx.strokeStyle = hot ? 'rgba(150,240,255,0.95)' : 'rgba(230,242,255,0.55)';
  ctx.lineWidth = L * 0.008;
  ctx.stroke();

  // Fuller (the groove down the middle).
  ctx.beginPath();
  ctx.moveTo(base + L * 0.03, 0);
  ctx.lineTo(tip * 0.88, 0);
  ctx.strokeStyle = 'rgba(60,74,92,0.55)';
  ctx.lineWidth = bw * 0.42;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Guard.
  ctx.beginPath();
  ctx.roundRect(-L * 0.015, -L * 0.115, L * 0.075, L * 0.23, L * 0.03);
  const brass = ctx.createLinearGradient(0, -L * 0.11, 0, L * 0.11);
  brass.addColorStop(0, '#ffd97a');
  brass.addColorStop(0.5, '#c9932b');
  brass.addColorStop(1, '#8a6216');
  ctx.fillStyle = brass;
  ctx.fill();

  // Grip.
  ctx.beginPath();
  ctx.roundRect(-L * 0.25, -L * 0.032, L * 0.24, L * 0.064, L * 0.03);
  ctx.fillStyle = '#4a2f1d';
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,12,6,0.6)';
  ctx.lineWidth = L * 0.008;
  for (let i = 1; i < 5; i++) {
    const x = -L * 0.25 + (L * 0.24 * i) / 5;
    ctx.beginPath();
    ctx.moveTo(x, -L * 0.03);
    ctx.lineTo(x + L * 0.014, L * 0.03);
    ctx.stroke();
  }

  // Pommel.
  ctx.beginPath();
  ctx.arc(-L * 0.262, 0, L * 0.045, 0, TAU);
  ctx.fillStyle = brass;
  ctx.fill();

  if (tint) {
    // Wash the whole blade in the opponent's colour so it never gets mistaken
    // for your own. 'source-atop' keeps the tint inside the sword's own pixels,
    // and because sprites are baked once this costs nothing per frame.
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = tint;
    ctx.fillRect(-L * BACK, -L * HALF_H, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  return { canvas, w, h, ox: -L * BACK, oy: -L * HALF_H };
}

function get(length: number, dpr: number, hot: boolean, tint?: string): SwordSprite {
  // Quantise the size so small frame-to-frame changes don't rebuild the sprite.
  const q = Math.round(length / 4) * 4;
  const key = `${q}:${dpr}:${hot ? 'h' : 'c'}:${tint ?? ''}`;
  let s = cache.get(key);
  if (!s) {
    s = bake(q, dpr, hot, tint);
    cache.set(key, s);
  }
  return s;
}

export function clearSwordCache() {
  cache.clear();
}

export function drawSword(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
  dpr: number,
  hot: boolean,
  tint?: string,
) {
  const s = get(length, dpr, hot, tint);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);
  ctx.restore();
}

/**
 * The cutting edge, in world space: from just past the guard out to the tip.
 * The game collides fruit against this segment, not against the hand point, so
 * the sword's reach is real rather than decorative.
 */
export function bladeSegment(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  length: number,
): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: x + dirX * length * 0.1,
    y1: y + dirY * length * 0.1,
    x2: x + dirX * length,
    y2: y + dirY * length,
  };
}
