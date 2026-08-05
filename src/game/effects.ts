import { rand, easeOutCubic } from '../util/math';

interface Particle {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  maxLife: number;
  color: string;
  gravity: number;
}

interface Ring {
  alive: boolean;
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  maxLife: number;
  color: string;
  width: number;
}

interface Popup {
  alive: boolean;
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  text: string;
  color: string;
  size: number;
}

const MAX_PARTICLES = 420;
const MAX_RINGS = 24;
const MAX_POPUPS = 24;

/**
 * Pooled effects layer. Nothing here allocates during play, and particles are
 * drawn batched by colour — one path and one fill per colour instead of a
 * path per particle, which is what actually keeps this affordable on an
 * integrated GPU.
 */
export class Effects {
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private popups: Popup[] = [];
  private buckets = new Map<string, Particle[]>();

  /** Persistent juice splats, kept on a half-resolution layer that slowly fades. */
  private splatCanvas: HTMLCanvasElement | null = null;
  private splatCtx: CanvasRenderingContext2D | null = null;
  private splatScale = 0.5;
  private width = 0;
  private height = 0;

  /** Dropped to 0 by the perf governor when frames get expensive. */
  quality = 1;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: 0,
        life: 0,
        maxLife: 1,
        color: '#fff',
        gravity: 1,
      });
    }
    for (let i = 0; i < MAX_RINGS; i++) {
      this.rings.push({
        alive: false,
        x: 0,
        y: 0,
        r0: 0,
        r1: 0,
        life: 0,
        maxLife: 1,
        color: '#fff',
        width: 2,
      });
    }
    for (let i = 0; i < MAX_POPUPS; i++) {
      this.popups.push({
        alive: false,
        x: 0,
        y: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        text: '',
        color: '#fff',
        size: 20,
      });
    }
  }

  resize(width: number, height: number, dpr: number) {
    this.width = width;
    this.height = height;
    if (!this.splatCanvas) {
      this.splatCanvas = document.createElement('canvas');
      this.splatCtx = this.splatCanvas.getContext('2d');
    }
    const s = this.splatScale * Math.min(dpr, 1.5);
    this.splatCanvas.width = Math.max(1, Math.floor(width * s));
    this.splatCanvas.height = Math.max(1, Math.floor(height * s));
    this.splatCtx?.setTransform(s, 0, 0, s, 0, 0);
    this.clearSplats();
  }

  clearSplats() {
    if (!this.splatCanvas || !this.splatCtx) return;
    this.splatCtx.save();
    this.splatCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.splatCtx.clearRect(0, 0, this.splatCanvas.width, this.splatCanvas.height);
    this.splatCtx.restore();
  }

  clear() {
    for (const p of this.particles) p.alive = false;
    for (const r of this.rings) r.alive = false;
    for (const p of this.popups) p.alive = false;
    this.clearSplats();
  }

  private freeParticle(): Particle | null {
    for (let i = 0; i < this.particles.length; i++) {
      if (!this.particles[i].alive) return this.particles[i];
    }
    return null;
  }

  /** Directional juice spray, e.g. along a cut or out of a punch. */
  burst(
    x: number,
    y: number,
    count: number,
    color: string,
    color2: string,
    opts: { speed?: number; angle?: number; spread?: number; size?: number; gravity?: number } = {},
  ) {
    const n = Math.round(count * (this.quality ? 1 : 0.45));
    const speed = opts.speed ?? 420;
    const angle = opts.angle ?? 0;
    const spread = opts.spread ?? Math.PI * 2;
    const size = opts.size ?? 6;
    const gravity = opts.gravity ?? 1;

    for (let i = 0; i < n; i++) {
      const p = this.freeParticle();
      if (!p) return;
      const a = angle + rand(-spread / 2, spread / 2);
      const sp = speed * rand(0.35, 1.15);
      p.alive = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.r = size * rand(0.5, 1.4);
      p.maxLife = rand(0.4, 0.95);
      p.life = p.maxLife;
      p.color = Math.random() < 0.6 ? color : color2;
      p.gravity = gravity;
    }
  }

  ring(x: number, y: number, r0: number, r1: number, color: string, life = 0.4, width = 4) {
    for (const r of this.rings) {
      if (r.alive) continue;
      r.alive = true;
      r.x = x;
      r.y = y;
      r.r0 = r0;
      r.r1 = r1;
      r.color = color;
      r.maxLife = life;
      r.life = life;
      r.width = width;
      return;
    }
  }

  popup(x: number, y: number, text: string, color: string, size = 22) {
    for (const p of this.popups) {
      if (p.alive) continue;
      p.alive = true;
      p.x = x;
      p.y = y;
      p.vy = -90;
      p.text = text;
      p.color = color;
      p.size = size;
      p.maxLife = 0.9;
      p.life = 0.9;
      return;
    }
  }

  /** Permanent-ish stain on the background layer. */
  splat(x: number, y: number, radius: number, color: string) {
    const ctx = this.splatCtx;
    if (!ctx || !this.quality) return;
    ctx.save();
    // Deliberately faint: these accumulate across a whole level, so anything
    // heavier stops reading as juice and starts reading as smudge.
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = color;
    const blobs = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < blobs; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * radius * 0.6;
      ctx.beginPath();
      ctx.ellipse(
        x + Math.cos(a) * d,
        y + Math.sin(a) * d,
        radius * rand(0.16, 0.38),
        radius * rand(0.16, 0.38),
        a,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  update(dt: number) {
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        continue;
      }
      p.vy += 1500 * p.gravity * dt;
      p.vx *= 1 - 1.6 * dt;
      p.vy *= 1 - 0.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y > this.height + 60) p.alive = false;
    }
    for (const r of this.rings) {
      if (!r.alive) continue;
      r.life -= dt;
      if (r.life <= 0) r.alive = false;
    }
    for (const p of this.popups) {
      if (!p.alive) continue;
      p.life -= dt;
      p.y += p.vy * dt;
      p.vy *= 1 - 2.2 * dt;
      if (p.life <= 0) p.alive = false;
    }
  }

  /** Splat layer sits under the fruit; call before drawing entities. */
  drawSplats(ctx: CanvasRenderingContext2D, dt: number) {
    if (!this.splatCanvas || !this.splatCtx) return;
    // Slow fade so stains accumulate but never fully saturate the screen.
    this.splatCtx.save();
    this.splatCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.splatCtx.globalCompositeOperation = 'destination-out';
    this.splatCtx.fillStyle = `rgba(0,0,0,${Math.min(0.6, dt * 0.8)})`;
    this.splatCtx.fillRect(0, 0, this.splatCanvas.width, this.splatCanvas.height);
    this.splatCtx.restore();

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.drawImage(this.splatCanvas, 0, 0, this.width, this.height);
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D) {
    // Bucket by colour so each colour costs one path + one fill.
    for (const list of this.buckets.values()) list.length = 0;
    for (const p of this.particles) {
      if (!p.alive) continue;
      let list = this.buckets.get(p.color);
      if (!list) {
        list = [];
        this.buckets.set(p.color, list);
      }
      list.push(p);
    }

    for (const [color, list] of this.buckets) {
      if (!list.length) continue;
      // Alpha can't vary within a batch, so use the batch's mean fade. Droplets
      // from one burst die together, which keeps this visually honest.
      let alphaSum = 0;
      ctx.beginPath();
      for (const p of list) {
        const t = p.life / p.maxLife;
        alphaSum += t;
        const r = p.r * (0.35 + t * 0.65);
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.globalAlpha = Math.min(1, alphaSum / list.length);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const r of this.rings) {
      if (!r.alive) continue;
      const t = 1 - r.life / r.maxLife;
      const radius = r.r0 + (r.r1 - r.r0) * easeOutCubic(t);
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - t * 0.6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (this.popups.some((p) => p.alive)) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of this.popups) {
        if (!p.alive) continue;
        const t = p.life / p.maxLife;
        ctx.globalAlpha = Math.min(1, t * 1.8);
        ctx.font = `800 ${p.size}px ui-rounded, "Avenir Next", system-ui, sans-serif`;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      }
      ctx.globalAlpha = 1;
    }
  }
}
