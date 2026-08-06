/**
 * All sound is synthesised at runtime — no audio files to load, and the whole
 * game stays a single self-contained bundle.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  enabled = true;

  /** Must be called from a user gesture (browsers block autostart otherwise). */
  resume() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);

      const len = Math.floor(this.ctx.sampleRate * 0.4);
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  private get t() {
    return this.ctx!.currentTime;
  }

  private tone(
    freqFrom: number,
    freqTo: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    delay = 0,
  ) {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t0 = this.t + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqFrom, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /**
   * Filtered noise burst.
   *
   * A bandpass throws away most of a broadband source, and the gain is applied
   * after the filter — so a nominal gain of 0.5 through a narrow band came out
   * around a twentieth of that. The makeup term below compensates so `gain`
   * means roughly the same thing at any Q.
   */
  private noise(dur: number, gain: number, filterFrom: number, filterTo: number, q = 1, delay = 0) {
    if (!this.ctx || !this.master || !this.noiseBuffer || !this.enabled) return;
    const t0 = this.t + delay;
    const makeup = 1 + q * 1.6;
    gain *= makeup;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(filterFrom, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, filterTo), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /** Blade passing through air. Deliberately soft; it fires on every swing. */
  whoosh() {
    this.noise(0.16, 0.18, 900, 2600, 0.9);
  }

  /**
   * A cut, in three layers: the bright transient of the blade going through,
   * a wetter body underneath as the fruit opens, and a short tone so a flurry
   * of cuts stays legible instead of blurring into noise.
   *
   * `weight` comes from the fruit's mass, so a watermelon lands lower and
   * heavier than a strawberry. Pitch is jittered a few percent per hit because
   * identical repeats start to sound mechanical. That randomness is cosmetic
   * and must stay on Math.random, away from the seeded spawn stream.
   */
  slice(weight = 1) {
    const p = (1.15 / (0.5 + weight * 0.5)) * (0.94 + Math.random() * 0.12);
    // Low frequencies read as quieter at the same peak, so heavy fruit needs
    // extra body to actually feel heavier rather than just duller.
    const body = 0.16 * (0.75 + weight * 0.3);
    this.noise(0.085, 0.30, 5200 * p, 1100 * p, 0.7);
    this.noise(0.22, body, 1100 * p, 260 * p, 1.1, 0.012);
    this.tone(760 * p, 240 * p, 0.13, 'triangle', 0.2);
  }

  combo(step: number) {
    const base = 520 * Math.pow(1.12, Math.min(step, 10));
    this.tone(base, base * 1.5, 0.14, 'triangle', 0.14);
  }

  explode() {
    this.noise(0.7, 0.6, 1400, 60, 0.6);
    this.tone(120, 28, 0.6, 'sawtooth', 0.3);
  }

  miss() {
    this.tone(320, 150, 0.24, 'sine', 0.14);
  }

  levelUp() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, f, 0.18, 'triangle', 0.15, i * 0.09));
  }

  gameOver() {
    [440, 349, 262].forEach((f, i) => this.tone(f, f * 0.98, 0.4, 'sine', 0.18, i * 0.18));
  }
}
