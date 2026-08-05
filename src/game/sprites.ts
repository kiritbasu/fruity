import { FRUITS, type FruitDef, type FruitId } from './fruitDefs';

/**
 * How far each fruit's art extends past its collision radius, in radius units:
 * [left, top, right, bottom]. Kept tight so we aren't blitting large regions of
 * transparent pixels every frame — fill rate is the scarce resource on an
 * integrated GPU.
 */
const EXTENT: Partial<Record<FruitId, [number, number, number, number]>> = {
  watermelon: [1.12, 1.42, 1.12, 1.12],
  strawberry: [1.35, 1.85, 1.35, 1.15],
  banana: [1.2, 1.2, 1.2, 1.45],
  orange: [1.12, 1.55, 1.35, 1.12],
  grapes: [1.15, 1.6, 1.15, 1.35],
  tomato: [1.12, 1.3, 1.12, 1.12],
  coconut: [1.1, 1.15, 1.1, 1.1],
  pineapple: [1.15, 1.95, 1.15, 1.2],
  bomb: [1.15, 2.25, 1.35, 1.12],
};
const DEFAULT_EXTENT: [number, number, number, number] = [1.15, 1.4, 1.15, 1.2];

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Draw size in CSS px. */
  w: number;
  h: number;
  /** Offset from the fruit's centre to the sprite's top-left, in CSS px. */
  ox: number;
  oy: number;
}

const cache = new Map<string, Sprite>();

function bake(
  radius: number,
  dpr: number,
  extent: [number, number, number, number],
  paint: (ctx: CanvasRenderingContext2D, r: number) => void,
): Sprite {
  const [l, t, r2, b] = extent;
  const w = radius * (l + r2);
  const h = radius * (t + b);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w * dpr));
  canvas.height = Math.max(1, Math.ceil(h * dpr));

  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.translate(radius * l, radius * t);
  paint(ctx, radius);

  return { canvas, w, h, ox: -radius * l, oy: -radius * t };
}

/** Whole, undamaged fruit. */
export function getBodySprite(def: FruitDef, radius: number, dpr: number): Sprite {
  const key = `b:${def.id}:${radius.toFixed(1)}:${dpr}`;
  let s = cache.get(key);
  if (!s) {
    s = bake(radius, dpr, EXTENT[def.id] ?? DEFAULT_EXTENT, (ctx, r) => def.draw(ctx, r));
    cache.set(key, s);
  }
  return s;
}

/** Cross-section shown on a cut face. Always a plain circle, so extent is 1:1. */
export function getFleshSprite(def: FruitDef, radius: number, dpr: number): Sprite {
  const key = `f:${def.id}:${radius.toFixed(1)}:${dpr}`;
  let s = cache.get(key);
  if (!s) {
    s = bake(radius, dpr, [1.02, 1.02, 1.02, 1.02], (ctx, r) => def.flesh(ctx, r));
    cache.set(key, s);
  }
  return s;
}

const drawSprite = (ctx: CanvasRenderingContext2D, s: Sprite) =>
  ctx.drawImage(s.canvas, s.ox, s.oy, s.w, s.h);

/**
 * Draws one half of a cut fruit. The caller has already translated to the
 * chunk's position and applied its spin; `cutAngle` is the cut line's angle in
 * that frame and `side` picks which half of it to keep.
 *
 * The body is clipped to the half, then a vertically squashed flesh disc is
 * laid along the cut to read as the exposed cross-section.
 */
export function drawChunk(
  ctx: CanvasRenderingContext2D,
  def: FruitDef,
  radius: number,
  dpr: number,
  cutAngle: number,
  side: 1 | -1,
) {
  const body = getBodySprite(def, radius, dpr);
  const flesh = getFleshSprite(def, radius, dpr);
  const reach = radius * 2.6;

  ctx.save();
  ctx.rotate(cutAngle);

  ctx.beginPath();
  if (side < 0) ctx.rect(-reach, -reach, reach * 2, reach);
  else ctx.rect(-reach, 0, reach * 2, reach);
  ctx.clip();

  // Flesh lip sits just inside the cut so the body's rind frames it.
  ctx.save();
  ctx.translate(0, side * radius * 0.04);
  ctx.scale(1, 0.62);
  drawSprite(ctx, flesh);
  ctx.restore();

  ctx.save();
  ctx.rotate(-cutAngle);
  drawSprite(ctx, body);
  ctx.restore();

  // Re-lay a thinner flesh band on top so the body art doesn't bury the cut.
  ctx.save();
  ctx.translate(0, side * radius * 0.02);
  ctx.scale(1, 0.34);
  ctx.globalAlpha = 0.95;
  drawSprite(ctx, flesh);
  ctx.restore();

  ctx.restore();
}

export function drawWhole(
  ctx: CanvasRenderingContext2D,
  def: FruitDef,
  radius: number,
  dpr: number,
) {
  drawSprite(ctx, getBodySprite(def, radius, dpr));
}

/** Called on resize — sprite sizes are viewport-relative. */
export function clearSpriteCache() {
  cache.clear();
}

/** Warms the cache at level start so the first spawn doesn't hitch. */
export function prewarm(ids: readonly FruitId[], radiusFor: (id: FruitId) => number, dpr: number) {
  for (const id of ids) {
    const def = FRUITS[id];
    const r = radiusFor(id);
    getBodySprite(def, r, dpr);
    getFleshSprite(def, r, dpr);
  }
}
