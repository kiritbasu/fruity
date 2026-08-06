import { FRUITS, type FruitId } from './fruitDefs';
import { drawChunk } from './sprites';
import { clamp } from '../util/math';

/**
 * Most halves drawn at once. The pile is meant to read as "lots" rather than
 * be countable, so past this the bowl just looks full and the label carries
 * the real number.
 */
const MAX_VISIBLE = 30;

interface Item {
  id: FruitId;
  /** Fixed per item so a half does not jitter as the pile reflows. */
  jitterX: number;
  jitterY: number;
  tilt: number;
  /** Counts up from 0 so a new half can drop in rather than appear. */
  age: number;
}

/**
 * A bowl of the fruit a player has cut.
 *
 * This is the real scoreboard. A number tells you how you are doing; a bowl
 * filling up shows it, and in a two-player match you can compare two bowls
 * across the screen without reading any digits.
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
      jitterX: (Math.random() - 0.5) * 0.34,
      jitterY: (Math.random() - 0.5) * 0.24,
      tilt: (Math.random() - 0.5) * 0.6,
      age: 0,
    });
    if (this.items.length > MAX_VISIBLE) this.items.shift();
  }

  clear() {
    this.items.length = 0;
    this.total = 0;
  }

  get count() {
    return this.total;
  }

  update(dt: number) {
    for (const it of this.items) if (it.age < 1) it.age = Math.min(1, it.age + dt / 0.28);
  }

  /**
   * Draws the bowl and its contents. `cx` is the centre, `baseY` the bottom of
   * the foot.
   *
   * Built in three layers so the fruit genuinely sits inside: the back of the
   * rim, then the pile, then the bowl body over the front. Without that the
   * halves look like they are balanced on a saucer.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    cx: number,
    baseY: number,
    width: number,
    dpr: number,
    accent: string,
  ) {
    const bh = width * 0.46;
    const rimY = baseY - bh;
    const rx = width * 0.5;
    const ry = width * 0.11;

    this.drawPile(ctx, cx, rimY, width, dpr);
    this.drawBowl(ctx, cx, baseY, rimY, rx, ry, accent);
  }

  /** A mound of halves, widest at the bottom, tapering as it rises. */
  private drawPile(
    ctx: CanvasRenderingContext2D,
    cx: number,
    rimY: number,
    width: number,
    dpr: number,
  ) {
    const n = this.items.length;
    if (!n) return;

    // A triangular mound of base b holds b(b+1)/2, so invert that to pick a
    // base wide enough for what we are showing.
    const cols = clamp(Math.ceil((Math.sqrt(8 * n + 1) - 1) / 2), 3, 7);
    const r = (width * 0.78) / (cols * 1.2);
    const spacing = r * 1.2;
    const rowStep = r * 0.82;

    let i = 0;
    let row = 0;
    while (i < n && row < 9) {
      const inRow = Math.min(n - i, Math.max(1, cols - row));
      const rowW = (inRow - 1) * spacing;
      for (let c = 0; c < inRow; c++, i++) {
        const it = this.items[i];
        const x = cx - rowW / 2 + c * spacing + it.jitterX * r;
        // Only the very bottom of the base row tucks behind the rim; any lower
        // and the bowl swallows the fruit, which is the whole point of it.
        const y = rimY - r * 0.28 - row * rowStep + it.jitterY * r * 0.7;

        const pop = it.age < 1 ? 1 - it.age : 0;
        ctx.save();
        ctx.translate(x, y - r * 0.5 - pop * r * 2.2);
        ctx.rotate(it.tilt);
        ctx.scale(1 + pop * 0.2, 1 + pop * 0.2);
        ctx.globalAlpha = 1 - pop * 0.4;
        // Cut face up, the way fruit sits in a real bowl.
        drawChunk(ctx, FRUITS[it.id], r, dpr, 0, 1);
        ctx.restore();
      }
      row++;
    }
  }

  private drawBowl(
    ctx: CanvasRenderingContext2D,
    cx: number,
    baseY: number,
    rimY: number,
    rx: number,
    ry: number,
    accent: string,
  ) {
    const footW = rx * 0.42;
    const footH = ry * 0.55;

    ctx.save();

    // Foot.
    ctx.beginPath();
    ctx.ellipse(cx, baseY, footW, footH, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(18,23,34,0.95)';
    ctx.fill();

    // Stem between foot and bowl.
    ctx.beginPath();
    ctx.moveTo(cx - footW * 0.5, baseY);
    ctx.quadraticCurveTo(cx - footW * 0.34, baseY - ry * 1.6, cx - footW * 0.62, baseY - ry * 2.2);
    ctx.lineTo(cx + footW * 0.62, baseY - ry * 2.2);
    ctx.quadraticCurveTo(cx + footW * 0.34, baseY - ry * 1.6, cx + footW * 0.5, baseY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(24,31,45,0.95)';
    ctx.fill();

    // Bowl body: rim edges curving down to a rounded base.
    const bodyTop = rimY;
    const bodyBottom = baseY - ry * 2.0;
    ctx.beginPath();
    ctx.moveTo(cx - rx, bodyTop);
    ctx.bezierCurveTo(
      cx - rx,
      bodyTop + (bodyBottom - bodyTop) * 0.72,
      cx - rx * 0.52,
      bodyBottom,
      cx,
      bodyBottom,
    );
    ctx.bezierCurveTo(
      cx + rx * 0.52,
      bodyBottom,
      cx + rx,
      bodyTop + (bodyBottom - bodyTop) * 0.72,
      cx + rx,
      bodyTop,
    );
    ctx.closePath();
    const body = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
    body.addColorStop(0, 'rgba(38,48,68,0.98)');
    body.addColorStop(0.32, 'rgba(70,84,113,0.98)');
    body.addColorStop(0.6, 'rgba(44,55,78,0.98)');
    body.addColorStop(1, 'rgba(24,31,46,0.98)');
    ctx.fillStyle = body;
    ctx.fill();

    // Front half of the rim, drawn over the body so the lip reads as an edge.
    ctx.beginPath();
    ctx.ellipse(cx, rimY, rx, ry, 0, 0, Math.PI);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = Math.max(2, rx * 0.055);
    ctx.lineCap = 'round';
    ctx.stroke();

    // Back half, dimmer, so the bowl reads as open rather than as a disc.
    ctx.beginPath();
    ctx.ellipse(cx, rimY, rx, ry, 0, Math.PI, Math.PI * 2);
    ctx.globalAlpha = 0.28;
    ctx.stroke();

    // A soft sheen down the left of the body.
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.ellipse(cx - rx * 0.42, rimY + (bodyBottom - rimY) * 0.42, rx * 0.13, (bodyBottom - rimY) * 0.3, 0.15, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.restore();
  }
}
