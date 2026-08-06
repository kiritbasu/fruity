import { FRUITS, type FruitDef, type FruitId } from './fruitDefs';
import { drawChunk, drawWhole } from './sprites';
import { rand, clamp, pointSegmentDistance } from '../util/math';

/**
 * Gravity in viewport-heights per second squared, not pixels.
 *
 * Tuned for reaction time rather than realism: camera tracking adds latency on
 * top of the player's own, so fruit needs roughly three seconds of hang time to
 * be comfortably reachable. Expressing it relative to height means flight times
 * are identical whatever the window size — which is what lets two players on
 * different screens share one fruit schedule.
 */
export const GRAVITY_PER_H = 0.94;

export type FruitState = 'flying' | 'dead';

export class Fruit {
  def: FruitDef = FRUITS.watermelon;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  rot = 0;
  rotSpeed = 0;
  radius = 40;
  state: FruitState = 'dead';
  /** Drives the bomb's warning pulse. */
  age = 0;
  /**
   * Identifies this fruit to the other player. Spawns are deterministic, so
   * both machines hand the same id to the same fruit without ever sending it.
   */
  uid = 0;

  get alive() {
    return this.state !== 'dead';
  }

  spawn(id: FruitId, x: number, y: number, vx: number, vy: number, radius: number, uid = 0) {
    this.def = FRUITS[id];
    this.uid = uid;
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.radius = radius;
    this.rot = rand(0, Math.PI * 2);
    this.rotSpeed = rand(-2.2, 2.2);
    this.state = 'flying';
    this.age = 0;
  }

  update(dt: number, gravity: number) {
    if (this.state !== 'flying') return;
    this.age += dt;
    this.vy += gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rot += this.rotSpeed * dt;
  }

  draw(ctx: CanvasRenderingContext2D, dpr: number) {
    if (this.state === 'dead') return;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rot);
    drawWhole(ctx, this.def, this.radius, dpr);
    ctx.restore();
  }
}

export class Chunk {
  def: FruitDef = FRUITS.watermelon;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  rot = 0;
  rotSpeed = 0;
  radius = 40;
  cutAngle = 0;
  side: 1 | -1 = 1;
  life = 0;
  alive = false;

  spawn(
    def: FruitDef,
    x: number,
    y: number,
    vx: number,
    vy: number,
    radius: number,
    cutAngle: number,
    side: 1 | -1,
    rot: number,
  ) {
    this.def = def;
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.radius = radius;
    this.cutAngle = cutAngle;
    this.side = side;
    this.rot = rot;
    this.rotSpeed = rand(-4, 4) + side * 1.5;
    this.life = 2.4;
    this.alive = true;
  }

  update(dt: number, height: number, gravity: number) {
    if (!this.alive) return;
    this.life -= dt;
    this.vy += gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rot += this.rotSpeed * dt;
    if (this.life <= 0 || this.y > height + this.radius * 3) this.alive = false;
  }

  draw(ctx: CanvasRenderingContext2D, dpr: number) {
    if (!this.alive) return;
    ctx.save();
    ctx.globalAlpha = clamp(this.life / 0.5, 0, 1);
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rot);
    drawChunk(ctx, this.def, this.radius, dpr, this.cutAngle, this.side);
    ctx.restore();
  }
}

/**
 * The swipe ribbon. Points come from the render loop at 60Hz (interpolated
 * between tracker samples), so the trail stays smooth even though inference
 * only lands ~24 times a second.
 */
export class Blade {
  private pts: { x: number; y: number; t: number }[] = [];
  /** How long the arc stays on screen. */
  private readonly maxAge = 0.3;
  /**
   * How much of the arc still cuts. Shorter than what's drawn, so the visible
   * tail reads as a fading afterimage rather than leaving a permanent
   * kill-zone hanging in the air.
   */
  private readonly hitAge = 0.14;

  push(x: number, y: number, now: number) {
    this.pts.push({ x, y, t: now });
    this.prune(now);
  }

  prune(now: number) {
    while (this.pts.length && now - this.pts[0].t > this.maxAge * 1000) this.pts.shift();
    if (this.pts.length > 48) this.pts.splice(0, this.pts.length - 48);
  }

  /**
   * Distance from a point to the recent arc. Making the drawn arc the hitbox is
   * the whole trick: tracking latency means the sword is always a little behind
   * the player's actual hand, so testing only the current blade position asks
   * them to lead the target by an amount they can't see. The arc is where they
   * just swung, and it's what they're aiming with.
   */
  distanceTo(x: number, y: number, now: number): number {
    let best = Infinity;
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1];
      const b = this.pts[i];
      if (now - a.t > this.hitAge * 1000) continue;
      const d = pointSegmentDistance(x, y, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
    return best;
  }

  clear() {
    this.pts.length = 0;
  }

  draw(ctx: CanvasRenderingContext2D, now: number, color: string, maxWidth: number) {
    this.prune(now);
    const n = this.pts.length;
    if (n < 3) return;

    // Build a tapered ribbon: offset each point perpendicular to the local
    // direction by a width that grows toward the leading tip.
    const left: { x: number; y: number }[] = [];
    const right: { x: number; y: number }[] = [];

    for (let i = 0; i < n; i++) {
      const p = this.pts[i];
      const a = this.pts[Math.max(0, i - 1)];
      const b = this.pts[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;

      const t = i / (n - 1);
      const age = 1 - (now - p.t) / (this.maxAge * 1000);
      const w = (maxWidth * 0.5 * Math.pow(t, 0.7) * clamp(age, 0, 1)) / 1;
      left.push({ x: p.x - dy * w, y: p.y + dx * w });
      right.push({ x: p.x + dy * w, y: p.y - dx * w });
    }

    // Wide and soft rather than narrow and solid: a broad translucent sweep
    // reads as motion, where a crisp band next to the sword reads as a second
    // blade. Drawn as two passes plus a thin core for the glint.
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.fill();

    ctx.beginPath();
    const mid = (p: { x: number; y: number }, q: { x: number; y: number }) => ({
      x: p.x + (q.x - p.x) * 0.32,
      y: p.y + (q.y - p.y) * 0.32,
    });
    const innerL = left.map((p, i) => mid(p, this.pts[i]));
    const innerR = right.map((p, i) => mid(p, this.pts[i]));
    ctx.moveTo(innerL[0].x, innerL[0].y);
    for (let i = 1; i < innerL.length; i++) ctx.lineTo(innerL[i].x, innerL[i].y);
    for (let i = innerR.length - 1; i >= 0; i--) ctx.lineTo(innerR[i].x, innerR[i].y);
    ctx.closePath();
    ctx.globalAlpha = 0.4;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(this.pts[0].x, this.pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(this.pts[i].x, this.pts[i].y);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1.5, maxWidth * 0.09);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
