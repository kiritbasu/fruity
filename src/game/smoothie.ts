import { FRUITS, type FruitId } from './fruitDefs';
import { drawChunk } from './sprites';
import { clamp } from '../util/math';

export type SmoothieStage = 'fill' | 'blend' | 'pour' | 'done';

/** Fruit flying out of the bowls and into the jar. */
const FILL_SECONDS = 1.9;
/**
 * How long one piece takes to fly from its bowl into the jar. Launches are
 * spread across `FILL_SECONDS` minus this, so the last piece lands exactly as
 * the stage ends — spread across the whole window instead and the stragglers
 * are still mid-air when the flyers stop being drawn, and vanish.
 */
const FLIGHT_SECONDS = 0.65;
/** Blades running. This is the stretch players can tap to shake. */
const BLEND_SECONDS = 5;
/** Settling, foam, and the finished drink. */
const POUR_SECONDS = 1.8;

/** Most halves animated into the jar. Beyond this they arrive as juice. */
const MAX_FLYERS = 26;

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Flyer {
  id: FruitId;
  x0: number;
  y0: number;
  /** Seconds into the fill stage before this one sets off. */
  delay: number;
  spin: number;
  /** How far the flight path bows upward, so they arc rather than slide. */
  lift: number;
}

interface Bubble {
  x: number;
  y: number;
  r: number;
  vy: number;
  life: number;
}

function parseHex(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const v = Number.parseInt(full, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

const mix = (a: RGB, b: RGB, t: number): RGB => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});

const css = (c: RGB, alpha = 1) =>
  `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;

/** `roundRect` is too new to rely on for a 2019 Mac's Safari. */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

interface Geometry {
  cx: number;
  jarX: number;
  jarY: number;
  jarW: number;
  jarH: number;
  baseY: number;
  baseH: number;
}

/**
 * The end-of-game blender.
 *
 * Everything in the bowls goes in and comes out as one drink, which is a better
 * ending than a number: in a two-player match the two bowls pour into the same
 * jar, so the last thing on screen is something the pair made together rather
 * than a winner and a loser. Tapping the jar shakes it — it changes nothing and
 * scores nothing, it is just something to do while the motor runs.
 */
export class Smoothie {
  stage: SmoothieStage = 'done';
  /** Counts taps, purely so the screen can acknowledge them. */
  shakes = 0;
  /** Flyers that have reached the jar, so the game can sound each arrival. */
  landed = 0;

  private t = 0;
  private W = 0;
  private H = 0;
  private caption = '';
  private fruitCount = 0;

  private flyers: Flyer[] = [];
  private bubbles: Bubble[] = [];
  private palette: RGB[] = [];
  private blended: RGB = { r: 190, g: 90, b: 140 };

  /** Drives the churn, and speeds up briefly when someone shakes the jar. */
  private spin = 0;
  private shakeEnergy = 0;
  private lastShakeAt = -1;

  /**
   * `origins` are the bowl centres the fruit flies out of, so the two platters
   * visibly empty into the jar instead of fruit appearing from nowhere.
   */
  start(items: FruitId[], origins: { x: number; y: number }[], caption: string, w: number, h: number) {
    this.W = w;
    this.H = h;
    this.caption = caption;
    this.fruitCount = items.length;
    this.stage = 'fill';
    this.t = 0;
    this.spin = 0;
    this.shakes = 0;
    this.landed = 0;
    this.shakeEnergy = 0;
    this.lastShakeAt = -1;
    this.bubbles.length = 0;

    // The finished colour averages every piece, so a jar of watermelon really
    // does come out greener than a jar of strawberries.
    const all = items.map((id) => parseHex(FRUITS[id].juice));
    this.blended = all.length
      ? all.reduce((acc, c, i) => mix(acc, c, 1 / (i + 1)), all[0])
      : { r: 190, g: 90, b: 140 };

    // Bands are one per *kind*, not one per piece: thirty halves would draw
    // thirty three-pixel stripes, which reads as scanlines rather than fruit.
    const seen = new Set<string>();
    this.palette = [];
    for (const id of items) {
      const hex = FRUITS[id].juice;
      if (seen.has(hex)) continue;
      seen.add(hex);
      this.palette.push(parseHex(hex));
    }
    if (!this.palette.length) this.palette = [this.blended];

    // Animate a subset when the bowls are full: past a couple of dozen the jar
    // is a blur anyway, and every flyer is a sprite draw per frame.
    const step = Math.max(1, Math.ceil(items.length / MAX_FLYERS));
    this.flyers = [];
    for (let i = 0; i < items.length; i += step) {
      const origin = origins[i % Math.max(1, origins.length)] ?? { x: w * 0.5, y: h * 0.9 };
      this.flyers.push({
        id: items[i],
        // Spread the launch point across the bowl so they don't fly as a column.
        x0: origin.x + (Math.random() - 0.5) * w * 0.06,
        y0: origin.y + (Math.random() - 0.5) * h * 0.04,
        delay: (i / Math.max(1, items.length)) * (FILL_SECONDS - FLIGHT_SECONDS),
        spin: (Math.random() - 0.5) * 10,
        lift: 0.18 + Math.random() * 0.22,
      });
    }
  }

  /**
   * Keeps the blender centred if the window changes mid-blend. Flyer origins
   * are left alone: they are only on screen for the first two seconds, and a
   * mispositioned tap target matters more than a mispositioned launch.
   */
  resize(w: number, h: number) {
    this.W = w;
    this.H = h;
  }

  private geom(): Geometry {
    const jarW = clamp(Math.min(this.W * 0.2, this.H * 0.3), 130, 320);
    const jarH = jarW * 1.2;
    const cx = this.W / 2;
    const jarY = this.H * 0.28;
    const baseH = jarW * 0.4;
    return {
      cx,
      jarX: cx - jarW / 2,
      jarY,
      jarW,
      jarH,
      baseY: jarY + jarH,
      baseH,
    };
  }

  /** True if a point is on the blender, so a tap or a sword tip can shake it. */
  hits(x: number, y: number): boolean {
    if (this.stage !== 'blend') return false;
    const g = this.geom();
    return (
      x > g.jarX - g.jarW * 0.25 &&
      x < g.jarX + g.jarW * 1.25 &&
      y > g.jarY - g.jarH * 0.2 &&
      y < g.baseY + g.baseH
    );
  }

  /** Rate-limited so a held swing or a fast tapper can't drown the sound. */
  shake(): boolean {
    if (this.stage !== 'blend') return false;
    if (this.t - this.lastShakeAt < 0.12) return false;
    this.lastShakeAt = this.t;
    this.shakes++;
    this.shakeEnergy = Math.min(1.6, this.shakeEnergy + 0.55);

    const g = this.geom();
    for (let i = 0; i < 10; i++) {
      this.bubbles.push({
        x: g.jarX + g.jarW * (0.16 + Math.random() * 0.68),
        y: g.baseY - g.jarH * (0.1 + Math.random() * 0.5),
        r: g.jarW * (0.015 + Math.random() * 0.045),
        vy: -(40 + Math.random() * 130),
        life: 0.5 + Math.random() * 0.5,
      });
    }
    return true;
  }

  update(dt: number) {
    if (this.stage === 'done') return;
    this.t += dt;

    this.shakeEnergy = Math.max(0, this.shakeEnergy - dt * 1.5);
    this.spin += dt * (this.stage === 'blend' ? 9 + this.shakeEnergy * 11 : 1.5);

    for (const b of this.bubbles) {
      b.y += b.vy * dt;
      b.life -= dt;
    }
    if (this.bubbles.length > 90) this.bubbles.splice(0, this.bubbles.length - 90);
    this.bubbles = this.bubbles.filter((b) => b.life > 0);

    if (this.stage === 'blend') {
      const g = this.geom();
      // A steady simmer of bubbles, independent of shaking.
      if (Math.random() < dt * 26) {
        this.bubbles.push({
          x: g.jarX + g.jarW * (0.18 + Math.random() * 0.64),
          y: g.baseY - g.jarH * 0.08,
          r: g.jarW * (0.012 + Math.random() * 0.03),
          vy: -(25 + Math.random() * 60),
          life: 0.8 + Math.random() * 0.6,
        });
      }
    }

    if (this.stage === 'fill') {
      // How many have reached the jar. The game turns each new one into a plop.
      let arrived = 0;
      for (const f of this.flyers) if (this.t - f.delay >= FLIGHT_SECONDS) arrived++;
      this.landed = arrived;
    }

    if (this.stage === 'fill' && this.t >= FILL_SECONDS) {
      this.stage = 'blend';
      this.t = 0;
    } else if (this.stage === 'blend' && this.t >= BLEND_SECONDS) {
      this.stage = 'pour';
      this.t = 0;
    } else if (this.stage === 'pour' && this.t >= POUR_SECONDS) {
      this.stage = 'done';
    }
  }

  // --------------------------------------------------------------- rendering

  draw(ctx: CanvasRenderingContext2D, dpr: number) {
    if (this.stage === 'done') return;
    const g = this.geom();

    // Jitter the whole appliance rather than the liquid alone, so a shake reads
    // as the machine rocking on the counter.
    const j = this.shakeEnergy;
    ctx.save();
    if (j > 0) {
      ctx.translate(
        (Math.random() - 0.5) * j * 9,
        (Math.random() - 0.5) * j * 6,
      );
      ctx.rotate((Math.random() - 0.5) * j * 0.012);
    }

    this.drawGlow(ctx, g);
    this.drawBase(ctx, g);
    this.drawLiquid(ctx, g);
    this.drawGlass(ctx, g);
    this.drawLid(ctx, g);
    if (this.stage === 'fill') this.drawFlyers(ctx, g, dpr);
    this.drawCaption(ctx, g);

    ctx.restore();
  }

  private drawGlow(ctx: CanvasRenderingContext2D, g: Geometry) {
    const cy = g.jarY + g.jarH * 0.55;
    const r = g.jarW * 2.1;
    const grad = ctx.createRadialGradient(g.cx, cy, g.jarW * 0.2, g.cx, cy, r);
    const heat = this.stage === 'blend' ? 0.16 + this.shakeEnergy * 0.12 : 0.1;
    grad.addColorStop(0, css(this.blended, heat));
    grad.addColorStop(1, css(this.blended, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(g.cx - r, cy - r, r * 2, r * 2);
  }

  private drawBase(ctx: CanvasRenderingContext2D, g: Geometry) {
    const w = g.jarW * 1.16;
    const x = g.cx - w / 2;
    const y = g.baseY - 2;
    const h = g.baseH;

    ctx.save();
    // Body, tapering slightly toward the counter.
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w * 0.93, y + h);
    ctx.lineTo(x + w * 0.07, y + h);
    ctx.closePath();
    const body = ctx.createLinearGradient(x, 0, x + w, 0);
    body.addColorStop(0, 'rgba(32, 40, 57, 0.98)');
    body.addColorStop(0.3, 'rgba(74, 88, 116, 0.98)');
    body.addColorStop(0.62, 'rgba(41, 51, 72, 0.98)');
    body.addColorStop(1, 'rgba(22, 28, 42, 0.98)');
    ctx.fillStyle = body;
    ctx.fill();

    // Control dial, lit while the motor is running.
    const dx = g.cx;
    const dy = y + h * 0.55;
    const dr = h * 0.26;
    ctx.beginPath();
    ctx.arc(dx, dy, dr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(14, 18, 28, 0.95)';
    ctx.fill();
    ctx.strokeStyle =
      this.stage === 'blend' ? css(this.blended, 0.95) : 'rgba(150, 160, 180, 0.45)';
    ctx.lineWidth = Math.max(2, dr * 0.2);
    ctx.stroke();

    // Pointer on the dial spins with the blades.
    ctx.beginPath();
    ctx.moveTo(dx, dy);
    ctx.lineTo(dx + Math.cos(this.spin * 0.5) * dr * 0.7, dy + Math.sin(this.spin * 0.5) * dr * 0.7);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = Math.max(1.5, dr * 0.14);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The drink itself: one horizontal band per fruit, each sliding toward the
   * average colour as the blend runs, so you can watch a bowl of separate
   * fruit turn into a single drink.
   */
  private drawLiquid(ctx: CanvasRenderingContext2D, g: Geometry) {
    const pad = g.jarW * 0.055;
    const ix = g.jarX + pad;
    const iy = g.jarY + pad;
    const iw = g.jarW - pad * 2;
    const ih = g.jarH - pad * 2;

    const fill = this.fillFraction();
    if (fill <= 0.001) return;

    const blendT =
      this.stage === 'fill' ? 0 : this.stage === 'blend' ? clamp(this.t / BLEND_SECONDS, 0, 1) : 1;
    // Shaking mixes it faster, which is the one thing tapping visibly does.
    const merged = clamp(blendT + this.shakes * 0.02, 0, 1);

    const surfaceY = iy + ih * (1 - fill);
    const depth = iy + ih - surfaceY;

    ctx.save();
    roundRectPath(ctx, ix, iy, iw, ih, g.jarW * 0.14);
    ctx.clip();

    const n = this.palette.length;
    const bandH = depth / n;
    const churn = this.stage === 'blend' ? 1 : 0.15;
    for (let i = 0; i < n; i++) {
      const colour = mix(this.palette[n - 1 - i], this.blended, merged);
      // Bands slosh out of line while the blades are running, which reads as
      // churn without needing a real fluid simulation.
      const wobble = Math.sin(this.spin * 1.6 + i * 1.1) * bandH * 0.45 * churn;
      const y = surfaceY + i * bandH + wobble;
      ctx.fillStyle = css(colour, 0.95);
      ctx.fillRect(ix - 4, y, iw + 8, bandH + Math.abs(wobble) + 2);
    }

    // Wavy top surface, drawn lighter so it reads as the meniscus.
    const amp = (this.stage === 'blend' ? 7 : 2.5) * (1 + this.shakeEnergy);
    ctx.beginPath();
    ctx.moveTo(ix - 4, surfaceY + 40);
    for (let x = 0; x <= iw + 8; x += 6) {
      const y =
        surfaceY +
        Math.sin(x / (iw / 3.2) + this.spin * 1.9) * amp +
        Math.sin(x / (iw / 7) - this.spin * 1.2) * amp * 0.4;
      ctx.lineTo(ix - 4 + x, y);
    }
    ctx.lineTo(ix + iw + 4, surfaceY + 40);
    ctx.closePath();
    ctx.fillStyle = css(mix(this.blended, { r: 255, g: 255, b: 255 }, 0.35), 0.9);
    ctx.fill();

    for (const b of this.bubbles) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${clamp(b.life * 0.5, 0, 0.45)})`;
      ctx.fill();
    }

    this.drawBlades(ctx, g, iy, iw, ih);
    ctx.restore();
  }

  private drawBlades(
    ctx: CanvasRenderingContext2D,
    g: Geometry,
    iy: number,
    iw: number,
    ih: number,
  ) {
    const bx = g.cx;
    const by = iy + ih - g.jarW * 0.09;
    const r = iw * 0.3;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(this.spin);
    ctx.globalAlpha = this.stage === 'blend' ? 0.5 : 0.3;
    ctx.fillStyle = 'rgba(226, 234, 246, 0.9)';
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.rotate((i / 4) * Math.PI * 2);
      ctx.beginPath();
      ctx.ellipse(r * 0.5, 0, r * 0.5, r * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawGlass(ctx: CanvasRenderingContext2D, g: Geometry) {
    ctx.save();
    roundRectPath(ctx, g.jarX, g.jarY, g.jarW, g.jarH, g.jarW * 0.14);
    const glass = ctx.createLinearGradient(g.jarX, 0, g.jarX + g.jarW, 0);
    glass.addColorStop(0, 'rgba(255, 255, 255, 0.13)');
    glass.addColorStop(0.18, 'rgba(255, 255, 255, 0.04)');
    glass.addColorStop(0.8, 'rgba(255, 255, 255, 0.03)');
    glass.addColorStop(1, 'rgba(255, 255, 255, 0.12)');
    ctx.fillStyle = glass;
    ctx.fill();
    ctx.strokeStyle = 'rgba(226, 238, 255, 0.5)';
    ctx.lineWidth = Math.max(2, g.jarW * 0.016);
    ctx.stroke();

    // Pouring spout, so it is a blender jug rather than a tumbler.
    ctx.beginPath();
    ctx.moveTo(g.jarX + g.jarW * 0.76, g.jarY + 1);
    ctx.quadraticCurveTo(
      g.jarX + g.jarW * 1.06,
      g.jarY - g.jarH * 0.03,
      g.jarX + g.jarW * 0.93,
      g.jarY + g.jarH * 0.08,
    );
    ctx.strokeStyle = 'rgba(226, 238, 255, 0.45)';
    ctx.stroke();

    // Handle on the left.
    ctx.beginPath();
    ctx.moveTo(g.jarX + 2, g.jarY + g.jarH * 0.2);
    ctx.bezierCurveTo(
      g.jarX - g.jarW * 0.3,
      g.jarY + g.jarH * 0.24,
      g.jarX - g.jarW * 0.3,
      g.jarY + g.jarH * 0.62,
      g.jarX + 2,
      g.jarY + g.jarH * 0.66,
    );
    ctx.lineWidth = Math.max(3, g.jarW * 0.055);
    ctx.strokeStyle = 'rgba(150, 166, 192, 0.55)';
    ctx.stroke();

    // Vertical sheen down the glass.
    ctx.globalAlpha = 0.14;
    ctx.beginPath();
    ctx.ellipse(
      g.jarX + g.jarW * 0.2,
      g.jarY + g.jarH * 0.45,
      g.jarW * 0.05,
      g.jarH * 0.34,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  private drawLid(ctx: CanvasRenderingContext2D, g: Geometry) {
    const w = g.jarW * 1.04;
    const h = g.jarW * 0.12;
    // Propped against the jar while fruit is still going in, then it drops on.
    // Set aside sideways rather than straight up, which would put it over the
    // match clock at the top of the screen.
    const seat = this.stage === 'fill' ? 0 : clamp(this.t / 0.35, 0, 1);
    const x = g.cx + (1 - seat) * g.jarW * 0.72;
    const y = g.jarY - h * 0.62 - (1 - seat) * g.jarH * 0.1;
    const tilt = (1 - seat) * 0.7;

    ctx.save();
    ctx.translate(x, y + h / 2);
    ctx.rotate(tilt);
    roundRectPath(ctx, -w / 2, -h / 2, w, h, h * 0.45);
    const lid = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    lid.addColorStop(0, 'rgba(44, 54, 76, 0.98)');
    lid.addColorStop(0.35, 'rgba(96, 112, 144, 0.98)');
    lid.addColorStop(1, 'rgba(30, 38, 55, 0.98)');
    ctx.fillStyle = lid;
    ctx.fill();
    // Knob.
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.5, w * 0.09, h * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120, 136, 168, 0.95)';
    ctx.fill();
    ctx.restore();
  }

  private drawFlyers(ctx: CanvasRenderingContext2D, g: Geometry, dpr: number) {
    const targetX = g.cx;
    const targetY = g.jarY + g.jarH * 0.4;
    const r = g.jarW * 0.15;

    for (const f of this.flyers) {
      const local = this.t - f.delay;
      if (local <= 0) continue;
      const p = clamp(local / FLIGHT_SECONDS, 0, 1);
      if (p >= 1) continue;

      // Ease out, and bow the path upward so they lob in rather than slide.
      const e = 1 - Math.pow(1 - p, 2.2);
      const x = f.x0 + (targetX - f.x0) * e;
      const y = f.y0 + (targetY - f.y0) * e - Math.sin(p * Math.PI) * this.H * f.lift;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(f.spin * p);
      // Shrink into the jar mouth so arrival reads as going in, not landing on.
      const s = 1 - p * 0.35;
      ctx.scale(s, s);
      ctx.globalAlpha = clamp((1 - p) * 3, 0, 1);
      drawChunk(ctx, FRUITS[f.id], r, dpr, 0, 1);
      ctx.restore();
    }
  }

  private drawCaption(ctx: CanvasRenderingContext2D, g: Geometry) {
    const y = g.baseY + g.baseH + this.H * 0.045;
    const size = Math.round(clamp(g.jarW * 0.17, 15, 32));

    let line = this.caption;
    let sub = '';
    if (this.stage === 'fill') {
      sub = `${this.fruitCount} fruit`;
    } else if (this.stage === 'blend') {
      // Deliberately not "tap": a camera player shakes it by swinging at it.
      sub = this.shakes ? `${this.shakes} shakes` : 'give the blender a shake';
    } else {
      line = 'One smoothie';
      sub = this.shakes ? `shaken ${this.shakes} times` : 'perfectly smooth';
    }

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';

    ctx.font = `800 ${size}px ui-rounded, "Avenir Next", system-ui, sans-serif`;
    ctx.strokeText(line, g.cx, y);
    ctx.fillStyle = css(mix(this.blended, { r: 255, g: 255, b: 255 }, 0.45));
    ctx.fillText(line, g.cx, y);

    ctx.font = `600 ${Math.round(size * 0.62)}px ui-rounded, "Avenir Next", system-ui, sans-serif`;
    ctx.strokeText(sub, g.cx, y + size * 1.25);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.fillText(sub, g.cx, y + size * 1.25);
    ctx.restore();
  }

  /** How full the jar is, 0..1, across the three stages. */
  private fillFraction(): number {
    switch (this.stage) {
      case 'fill':
        return clamp(this.t / FILL_SECONDS, 0, 1) * 0.62;
      case 'blend':
        return 0.62;
      case 'pour':
        // Settles as the foam collapses.
        return 0.62 - clamp(this.t / POUR_SECONDS, 0, 1) * 0.05;
      default:
        return 0;
    }
  }
}
