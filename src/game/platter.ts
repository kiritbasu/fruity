import { FRUITS, type FruitId } from './fruitDefs';
import { drawChunk } from './sprites';
import { clamp } from '../util/math';

/** Most halves shown at once. Past this the oldest drop off the back. */
const MAX_ITEMS = 34;
/** Item size as a fraction of the platter's width, before crowding shrinks it. */
const BASE_ITEM = 0.088;

interface Item {
  id: FruitId;
  /** Fixed per item so a half does not jitter as the heap reflows. */
  jitterX: number;
  jitterY: number;
  tilt: number;
  /** Counts up from 0 so a new half can pop as it lands. */
  age: number;
}

/**
 * The pile of fruit a player has cut.
 *
 * This is the actual scoreboard. A number tells you how you are doing; a heap
 * of fruit shows it, and in a two-player match you can read both at a glance
 * without comparing digits.
 */
export class Platter {
  private items: Item[] = [];
  private total = 0;

  add(id: FruitId) {
    if (id === 'bomb') return;
    this.total++;
    this.items.push({
      id,
      // Cosmetic only, so this must stay on Math.random and away from the
      // seeded spawn stream.
      jitterX: (Math.random() - 0.5) * 0.5,
      jitterY: (Math.random() - 0.5) * 0.35,
      tilt: (Math.random() - 0.5) * 0.7,
      age: 0,
    });
    if (this.items.length > MAX_ITEMS) this.items.shift();
  }

  clear() {
    this.items.length = 0;
    this.total = 0;
  }

  get count() {
    return this.total;
  }

  update(dt: number) {
    for (const it of this.items) if (it.age < 1) it.age = Math.min(1, it.age + dt / 0.25);
  }

  /**
   * Draws the plate and its heap, centred on `cx` and resting on `baseY`.
   * Items shrink as the heap grows so the pile keeps visibly building instead
   * of hitting a wall the moment the first row is full.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    cx: number,
    baseY: number,
    width: number,
    dpr: number,
    accent: string,
  ) {
    const n = this.items.length;
    const r = width * BASE_ITEM * clamp(Math.sqrt(9 / Math.max(1, n)), 0.5, 1);
    const perRow = Math.max(4, Math.floor((width * 0.9) / (r * 1.15)));
    const spacing = (width * 0.9) / perRow;
    const rowStep = r * 0.72;

    // The plate: a shallow ellipse with a lit rim, drawn behind everything.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, baseY, width * 0.5, width * 0.062, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,13,20,0.72)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(1.5, width * 0.005);
    ctx.stroke();
    ctx.restore();

    // Oldest first, so newer halves overlap onto the pile.
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const x =
        cx - width * 0.45 + spacing * (col + 0.5) + (row % 2 ? spacing * 0.5 : 0) + it.jitterX * r;
      const y = baseY - row * rowStep + it.jitterY * r * 0.4;

      // A new half drops in rather than appearing.
      const pop = it.age < 1 ? 1 - it.age : 0;
      const lift = pop * r * 1.8;
      const scale = 1 + pop * 0.25;

      ctx.save();
      ctx.translate(x, y - r * 0.55 - lift);
      ctx.rotate(it.tilt);
      ctx.scale(scale, scale);
      ctx.globalAlpha = 1 - pop * 0.35;
      // Cut face up, the way fruit actually sits on a platter.
      drawChunk(ctx, FRUITS[it.id], r, dpr, 0, 1);
      ctx.restore();
    }
  }
}
