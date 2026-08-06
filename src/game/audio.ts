/**
 * All sound is synthesised at runtime — no audio files to load, and the whole
 * game stays a single self-contained bundle.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private muted = false;

  get enabled() {
    return !this.muted;
  }

  /**
   * One-shots check this when they are fired, so muting simply stops new ones
   * starting. The blender motor is a sustained voice that is already playing by
   * then, so it has to be stopped here or muting mid-blend leaves it running.
   */
  set enabled(on: boolean) {
    this.muted = !on;
    if (!on) this.motorStop();
  }

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

  // ------------------------------------------------------------ the smoothie

  /**
   * The blender motor: a sustained voice rather than a one-shot, because it has
   * to run for as long as the blend does and bend when someone shakes the jar.
   */
  private motor: {
    osc: OscillatorNode;
    grind: AudioBufferSourceNode;
    gain: GainNode;
    filter: BiquadFilterNode;
  } | null = null;

  motorStart() {
    if (!this.ctx || !this.master || !this.noiseBuffer || !this.enabled || this.motor) return;
    const t0 = this.t;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.2, t0 + 0.35);
    gain.connect(this.master);

    // Low sawtooth for the motor itself.
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(38, t0);
    osc.frequency.linearRampToValueAtTime(74, t0 + 0.4);

    // Looped noise through a lowpass for the sound of fruit being thrown around.
    const grind = this.ctx.createBufferSource();
    grind.buffer = this.noiseBuffer;
    grind.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, t0);
    filter.frequency.linearRampToValueAtTime(1100, t0 + 0.4);
    filter.Q.value = 3;

    const grindGain = this.ctx.createGain();
    grindGain.gain.value = 0.5;

    osc.connect(gain);
    grind.connect(filter).connect(grindGain).connect(gain);
    osc.start(t0);
    grind.start(t0);
    this.motor = { osc, grind, gain, filter };
  }

  /** A shake revs the motor and opens the filter for a moment. */
  motorRev() {
    if (!this.motor || !this.ctx) return;
    const t0 = this.t;
    const { osc, filter } = this.motor;
    osc.frequency.cancelScheduledValues(t0);
    osc.frequency.setValueAtTime(osc.frequency.value, t0);
    osc.frequency.linearRampToValueAtTime(112, t0 + 0.07);
    osc.frequency.linearRampToValueAtTime(74, t0 + 0.45);
    filter.frequency.cancelScheduledValues(t0);
    filter.frequency.setValueAtTime(filter.frequency.value, t0);
    filter.frequency.linearRampToValueAtTime(2400, t0 + 0.07);
    filter.frequency.linearRampToValueAtTime(1100, t0 + 0.45);
  }

  motorStop() {
    if (!this.motor || !this.ctx) return;
    const { osc, grind, gain } = this.motor;
    const t0 = this.t;
    gain.gain.cancelScheduledValues(t0);
    gain.gain.setValueAtTime(gain.gain.value, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    // Wind the pitch down so it spins to a halt rather than being cut off.
    osc.frequency.cancelScheduledValues(t0);
    osc.frequency.setValueAtTime(osc.frequency.value, t0);
    osc.frequency.linearRampToValueAtTime(24, t0 + 0.3);
    osc.stop(t0 + 0.36);
    grind.stop(t0 + 0.36);
    this.motor = null;
  }

  /** Ice and fruit knocking about inside the jar when it gets shaken. */
  rattle() {
    this.noise(0.09, 0.22, 2600, 700, 1.6);
    this.tone(180 + Math.random() * 90, 90, 0.1, 'square', 0.09);
  }

  /** Fruit dropping into the jar. */
  plop(weight = 1) {
    const p = 1.2 / (0.6 + weight * 0.4);
    this.tone(320 * p, 120 * p, 0.11, 'sine', 0.13);
    this.noise(0.07, 0.14, 1400 * p, 500 * p, 1.2);
  }

  /** Thick liquid settling once the blades stop. */
  glug() {
    [0, 0.13, 0.25].forEach((d, i) =>
      this.tone(220 - i * 40, 110 - i * 25, 0.16, 'sine', 0.16, d),
    );
    this.noise(0.4, 0.1, 700, 200, 0.9, 0.05);
  }

  /** Drink's ready. */
  chime() {
    [784, 988, 1319].forEach((f, i) => this.tone(f, f, 0.5, 'sine', 0.16, i * 0.1));
  }
}
