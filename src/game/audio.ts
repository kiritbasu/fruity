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

  private noise(dur: number, gain: number, filterFrom: number, filterTo: number, q = 1, delay = 0) {
    if (!this.ctx || !this.master || !this.noiseBuffer || !this.enabled) return;
    const t0 = this.t + delay;
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

  /** Blade passing through air. */
  whoosh() {
    this.noise(0.16, 0.16, 900, 2600, 0.9);
  }

  slice() {
    this.noise(0.13, 0.5, 3200, 500, 2.2);
    this.tone(680, 220, 0.14, 'triangle', 0.16);
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
