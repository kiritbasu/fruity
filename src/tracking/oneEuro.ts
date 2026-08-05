/**
 * 1€ filter (Casiez et al.) — the standard low-latency jitter filter for
 * interactive pointing. It adapts the cutoff frequency to speed: heavy
 * smoothing when the hand is still (kills landmark jitter), almost none when
 * it's moving fast (keeps swipes responsive).
 */
class LowPass {
  private y = 0;
  private initialized = false;

  filter(x: number, alpha: number): number {
    if (!this.initialized) {
      this.y = x;
      this.initialized = true;
      return x;
    }
    this.y = alpha * x + (1 - alpha) * this.y;
    return this.y;
  }

  get value(): number {
    return this.y;
  }

  reset() {
    this.initialized = false;
    this.y = 0;
  }
}

export class OneEuroFilter {
  private xFilter = new LowPass();
  private dxFilter = new LowPass();
  private lastTime: number | null = null;
  private lastRaw = 0;
  private hasRaw = false;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.03,
    private dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, timestampMs: number): number {
    const dt =
      this.lastTime === null ? 1 / 30 : Math.max(1e-3, (timestampMs - this.lastTime) / 1000);
    this.lastTime = timestampMs;

    const rawDerivative = this.hasRaw ? (value - this.lastRaw) / dt : 0;
    this.lastRaw = value;
    this.hasRaw = true;

    const edx = this.dxFilter.filter(rawDerivative, OneEuroFilter.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = null;
    this.hasRaw = false;
  }
}

export class OneEuroVec2 {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;

  constructor(minCutoff = 1.2, beta = 0.03, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  filter(x: number, y: number, t: number): { x: number; y: number } {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
  }
}
