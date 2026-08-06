import type { InputSource, ScreenHand } from '../tracking/types';
import { clamp, pointSegmentDistance, rand } from '../util/math';
import { Sfx } from './audio';
import { Effects } from './effects';
import { Blade, Chunk, Fruit, GRAVITY_PER_H } from './entities';
import { FRUITS, SLICE_COLOR, type FruitId } from './fruitDefs';
import { levelAt, type LevelDef } from './levels';
import { clearSpriteCache, prewarm } from './sprites';
import { Platter } from './platter';
import { Smoothie, type SmoothieStage } from './smoothie';
import { bladeSegment, clearSwordCache, drawSword } from './sword';
import { Rng, randomSeed } from '../util/rng';
import { emptyRemote, type RemoteState } from '../net/protocol';
import type { Hud } from './hud';

export type Phase = 'idle' | 'intro' | 'playing' | 'levelClear' | 'smoothie' | 'gameOver';
export type Mode = 'solo' | 'versus';

/** Colour of the opponent's ghosted sword and arc. */
const GHOST_COLOR = '#ff8ad4';
/** Wash applied to the opponent's blade so it never reads as your own. */
const GHOST_TINT = 'rgba(255, 122, 205, 0.62)';
/** Opponent hand packets older than this stop being drawn. */
const GHOST_STALE_MS = 500;

/** Versus: how long each level's fruit mix lasts before the next one. */
const VERSUS_LEVEL_SECONDS = 45;
/** Versus: points lost for hitting a bomb, instead of a life. */
const BOMB_PENALTY = 50;

/**
 * Speed above which the sword cuts, as a fraction of viewport height per
 * second. Deliberately low — camera tracking already costs the player 60-100ms,
 * so demanding a hard swing on top of that makes the game feel unresponsive.
 */
const SLICE_SPEED = 0.17;
/** Once the sword is cutting it stays cutting this long, in ms. */
const HOT_WINDOW = 280;
const COMBO_WINDOW = 0.75;
/** Extra reach around the blade, as a fraction of viewport height. */
const HIT_PAD = 0.035;
const START_LIVES = 5;

/**
 * Versus runs a bigger wave than solo off the same roll.
 *
 * Both players cut from one shared board, so a wave sized for a single player
 * leaves whoever swings second with nothing to hit. Both peers derive this from
 * the level and their own mode, which is identical on both machines, so the
 * spawn stream stays in step.
 */
const VERSUS_WAVE_BONUS = 1.6;

/**
 * Pool sizes. The late levels put six to eight fruit up every second with
 * roughly three seconds of hang time, and versus adds to that again, so these
 * need real headroom — a pool that runs dry silently drops spawns.
 */
const MAX_FRUIT = 56;
const MAX_CHUNKS = 64;

/** The sword's geometry for one frame, plus where it was on the last one. */
interface SwordPose {
  length: number;
  hot: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  prevX1: number;
  prevY1: number;
  prevX2: number;
  prevY2: number;
  speed: number;
}

interface SwordState {
  hotUntil: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export class Game {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  width = 0;
  height = 0;

  private fruits: Fruit[] = [];
  private chunks: Chunk[] = [];
  private blades = new Map<string, Blade>();
  private swords = new Map<string, SwordState>();
  private fx = new Effects();
  /** What each player has cut. The visible scoreboard. */
  readonly platter = new Platter();
  readonly remotePlatter = new Platter();
  readonly sfx = new Sfx();
  private smoothie = new Smoothie();
  /** The result panel, held back until the blender has finished. */
  private afterSmoothie: (() => void) | null = null;
  private lastHandShakeAt = 0;
  private landedSoFar = 0;
  private lastPlopAt = 0;

  phase: Phase = 'idle';
  score = 0;
  best = Number(localStorage.getItem('fruity.best') ?? 0);
  lives = START_LIVES;
  levelIndex = 0;
  private level: LevelDef = levelAt(0);
  private destroyed = 0;
  private combo = 0;
  private comboTimer = 0;

  mode: Mode = 'solo';
  /** Drives every spawn decision; identical on both peers in a versus match. */
  private rng = new Rng(1);
  private matchSeed = 1;
  /** Wall-clock ms at which the current level started, for drift-free spawns. */
  private levelStartedAt = 0;
  /** Seconds into the level at which the next wave is due. */
  private nextWaveAt = 0;
  /**
   * Counts spawns within the level. Both players run the same spawn sequence,
   * so the same fruit gets the same number on both machines and a cut can name
   * it without either side having to agree on an id first.
   */
  private spawnSeq = 0;
  /** Versus only: seconds remaining in the whole match. */
  private matchSecondsLeft = 0;
  private matchDuration = 180;
  readonly remote: RemoteState = emptyRemote();
  private remoteBlade = new Blade();
  private lastHandSentAt = 0;

  /** Set by the multiplayer layer; no-ops in solo. */
  onLocalHand: ((h: { x: number; y: number; dx: number; dy: number; len: number; hot: boolean }) => void) | null = null;
  onScoreChanged: ((score: number, combo: number) => void) | null = null;
  /** Fires when this player cuts a fruit, so it can leave the other board too. */
  onFruitCut: ((uid: number, angle: number, fruit: FruitId) => void) | null = null;
  /** Fires when this player shakes the blender, so the other jar rattles too. */
  onSmoothieShake: (() => void) | null = null;
  /** Which candidate pair the peer connection settled on, for the debug overlay. */
  netRoute: (() => string) | null = null;
  onMatchOver: ((score: number) => void) | null = null;

  private phaseTimer = 0;
  private shake = 0;
  private lastFrame = 0;
  private rafId = 0;

  /** Rolling frame cost, used by the quality governor. */
  private avgFrameMs = 16;
  private slowFrames = 0;
  private fastFrames = 0;
  private quality = 1;
  showDebug = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private tracker: InputSource,
    private hud: Hud,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;

    for (let i = 0; i < MAX_FRUIT; i++) this.fruits.push(new Fruit());
    for (let i = 0; i < MAX_CHUNKS; i++) this.chunks.push(new Chunk());

    this.resize();
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.phase === 'playing') this.pause();
    });
  }

  /** Taps on the blender during the smoothie. Ignored the rest of the time. */
  private onPointerDown = (e: PointerEvent) => {
    if (this.phase !== 'smoothie') return;
    const r = this.canvas.getBoundingClientRect();
    if (!this.smoothie.hits(e.clientX - r.left, e.clientY - r.top)) return;
    if (this.shakeSmoothie()) this.onSmoothieShake?.();
  };

  // ---------------------------------------------------------------- lifecycle

  start() {
    this.mode = 'solo';
    this.matchSeed = randomSeed();
    this.reset();
  }

  /**
   * Both peers call this with the same seed, so both boards generate an
   * identical fruit sequence. Nothing about the fruit itself is ever sent over
   * the network — only the seed, once, at the start.
   */
  startVersus(seed: number, durationSeconds: number) {
    this.mode = 'versus';
    this.matchSeed = seed >>> 0;
    this.matchDuration = durationSeconds;
    this.matchSecondsLeft = durationSeconds;
    this.remote.done = false;
    this.remote.score = 0;
    this.reset();
  }

  private reset() {
    this.score = 0;
    this.lives = START_LIVES;
    this.levelIndex = 0;
    // Restarting out of the blender must not leave the motor running.
    this.sfx.motorStop();
    this.smoothie.stage = 'done';
    this.afterSmoothie = null;
    this.remoteBlade.clear();
    this.platter.clear();
    this.remotePlatter.clear();
    this.beginLevel(0);
    this.lastFrame = performance.now();
    if (!this.rafId) this.rafId = requestAnimationFrame(this.frame);
  }

  private beginLevel(index: number) {
    this.levelIndex = index;
    this.level = levelAt(index);
    this.destroyed = 0;
    this.combo = 0;
    // A fresh stream per level keeps the two peers in step even if one of them
    // reloads mid-match.
    this.rng = Rng.forLevel(this.matchSeed, index);
    this.nextWaveAt = 0.6;
    this.spawnSeq = 0;
    this.phase = 'intro';
    this.phaseTimer = this.mode === 'versus' ? 1.6 : 2.6;
    this.clearBoard();
    prewarm(this.level.fruits.concat('bomb'), (id) => this.radiusFor(id), this.dpr);
    this.hud.showLevelCard(this.level);
  }

  private clearBoard() {
    for (const f of this.fruits) f.state = 'dead';
    for (const c of this.chunks) c.alive = false;
    for (const b of this.blades.values()) b.clear();
    this.fx.clear();
  }

  pause() {
    if (this.phase === 'playing') {
      this.phase = 'idle';
      this.hud.showPaused();
    }
  }

  /**
   * Stands the game down so another screen can own the overlay.
   *
   * pause() is not enough: it only acts from 'playing', so opening the lobby
   * during the level intro left the phase machine running, and its transition
   * to 'playing' called hideOverlay() — pulling the lobby panel off the screen.
   */
  suspend() {
    this.phase = 'idle';
    this.clearBoard();
  }

  resumeFromPause() {
    if (this.phase === 'idle') {
      this.phase = 'playing';
      this.lastFrame = performance.now();
      this.hud.hideOverlay();
    }
  }

  stop() {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.sfx.motorStop();
    window.removeEventListener('resize', this.resize);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
  }

  // ------------------------------------------------------------------ layout

  private resize = () => {
    // A 2019 Intel Mac at DPR 2 on a full-screen canvas is 4× the fill cost of
    // DPR 1 for very little visible gain in a fast-moving game. 1.5 is the
    // sweet spot; the governor drops it to 1 if frames get expensive.
    const cap = this.quality ? 1.5 : 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    clearSpriteCache();
    clearSwordCache();
    this.fx.resize(this.width, this.height, this.dpr);
  };

  private radiusFor(id: FruitId) {
    return FRUITS[id].size * this.height;
  }

  // -------------------------------------------------------------- main loop

  private frame = (now: number) => {
    this.rafId = requestAnimationFrame(this.frame);

    const rawDt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    // Cap dt so a GC pause or tab switch can't teleport everything.
    const dt = clamp(rawDt, 0, 0.05);

    this.avgFrameMs = this.avgFrameMs * 0.92 + rawDt * 1000 * 0.08;
    this.governQuality();

    const hands = this.tracker.getHands(now, this.width, this.height);
    this.hud.setHandPresent(hands.length > 0);

    this.update(dt, now, hands);
    this.broadcastHand(now, hands);
    this.render(now, hands, dt);
  };

  /**
   * Publishes the local hand at roughly tracker rate. Positions go out
   * normalised so they land in the right place on a window of any size.
   */
  private broadcastHand(now: number, hands: ScreenHand[]) {
    if (!this.onLocalHand) return;
    if (now - this.lastHandSentAt < 33) return;
    this.lastHandSentAt = now;

    const hand = hands[0];
    if (!hand) return;
    const sword = this.swords.get(hand.id);
    const len = sword ? Math.hypot(sword.x2 - sword.x1, sword.y2 - sword.y1) / 0.9 : 0;
    this.onLocalHand({
      x: hand.x / this.width,
      y: hand.y / this.height,
      dx: hand.dirX,
      dy: hand.dirY,
      len: len / this.height,
      hot: now < (sword?.hotUntil ?? 0),
    });
  }

  /**
   * Sheds visual cost when the frame budget slips. Particle counts and the
   * splat layer go first because they're pure garnish; render scale goes last.
   */
  private governQuality() {
    if (this.avgFrameMs > 21) {
      this.slowFrames++;
      this.fastFrames = 0;
      if (this.slowFrames > 90 && this.quality === 1) {
        this.quality = 0;
        this.fx.quality = 0;
        this.slowFrames = 0;
        this.resize();
      }
    } else if (this.avgFrameMs < 14.5) {
      this.fastFrames++;
      this.slowFrames = 0;
      if (this.fastFrames > 300 && this.quality === 0) {
        this.quality = 1;
        this.fx.quality = 1;
        this.fastFrames = 0;
        this.resize();
      }
    }
  }

  // ---------------------------------------------------------------- updating

  private update(dt: number, now: number, hands: ScreenHand[]) {
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3.2);

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }

    switch (this.phase) {
      case 'intro':
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) {
          this.phase = 'playing';
          this.levelStartedAt = now;
          this.hud.hideOverlay();
        }
        break;

      case 'levelClear':
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) this.beginLevel(this.levelIndex + 1);
        break;

      case 'playing': {
        /*
         * Waves fire off elapsed wall-clock time rather than an accumulated dt.
         * Two machines running at different frame rates would otherwise drift
         * apart over a match, and the whole point is that both see the same
         * fruit at the same moment.
         */
        const elapsed = (now - this.levelStartedAt) / 1000;
        let guard = 0;
        while (elapsed >= this.nextWaveAt && guard++ < 8) {
          this.spawnWave();
          this.nextWaveAt += this.level.spawnInterval * this.rng.range(0.82, 1.18);
        }
        if (this.mode === 'versus') this.tickMatch(dt, elapsed);
        break;
      }

      case 'smoothie':
        this.tickSmoothie(dt, now, hands);
        break;

      case 'gameOver':
      case 'idle':
        break;
    }

    const gravity = GRAVITY_PER_H * this.height * this.level.tempo;

    for (const f of this.fruits) {
      if (!f.alive) continue;
      f.update(dt, gravity);
      if (f.state === 'flying' && f.y > this.height + f.radius * 2.5) {
        f.state = 'dead';
        if (this.phase === 'playing' && f.def.id !== 'bomb') this.onMiss(f.x);
      }
    }
    for (const c of this.chunks) c.update(dt, this.height, gravity);

    this.fx.update(dt);
    this.platter.update(dt);
    this.remotePlatter.update(dt);

    if (this.phase === 'playing') {
      this.resolveHands(hands, now);
    } else {
      // Keep the sword tracking between rounds, just without a cutting edge.
      for (const h of hands) {
        const s = this.swordFor(h, now);
        this.trail(h, now, false, s.x2, s.y2);
      }
    }
  }

  private spawnWave() {
    const rolled = this.rng.int(this.level.waveMin, this.level.waveMax);
    // The multiplier is applied after the roll, not folded into it, so the
    // stream advances by the wave size either way and both peers — always in
    // the same mode as each other — stay on the same sequence.
    const n = this.mode === 'versus' ? Math.ceil(rolled * VERSUS_WAVE_BONUS) : rolled;
    for (let i = 0; i < n; i++) this.launch(this.rng.pick(this.level.fruits));
    if (this.rng.next() < this.level.bombChance) this.launch('bomb');
  }

  /**
   * Every random value is drawn before the pool is checked. Bailing out early
   * would leave the two peers' RNG streams at different offsets, and from that
   * point on they would be playing different games.
   *
   * Positions are drawn as fractions of the viewport, not pixels, so the same
   * seed lays out the same board on two differently sized windows.
   */
  private launch(id: FruitId) {
    // Advanced before the early return below, for the same reason the random
    // draws are: both players must stay on the same sequence.
    const uid = this.levelIndex * 100000 + ++this.spawnSeq;
    const apexFrac = this.rng.range(0.06, 0.24);
    const xFrac = this.rng.range(0.12, 0.88);
    const driftFrac = this.rng.range(0.07, 0.22);
    const wobbleFrac = this.rng.range(-0.1, 0.1);

    const fruit = this.fruits.find((f) => !f.alive);
    if (!fruit) return;

    const radius = this.radiusFor(id);
    const gravity = GRAVITY_PER_H * this.height * this.level.tempo;
    const spawnY = this.height + radius * 1.5;
    // Aim the apex high: the higher it peaks, the longer it hangs, and hang
    // time is what gives the player room to react.
    const v0 = -Math.sqrt(2 * gravity * (spawnY - apexFrac * this.height));

    const x = xFrac * this.width;
    // Bias horizontal drift back toward centre so fruit doesn't exit sideways.
    const toCenter = (this.width / 2 - x) / (this.width / 2);
    const vx = (toCenter * driftFrac + wobbleFrac) * this.width;

    fruit.spawn(id, x, spawnY, vx, v0, radius, uid);
  }

  /** Versus match clock: levels rotate on a timer and the match has a hard end. */
  private tickMatch(dt: number, elapsedInLevel: number) {
    this.matchSecondsLeft -= dt;
    this.hud.setMatchClock(Math.max(0, this.matchSecondsLeft), this.matchDuration);

    if (this.matchSecondsLeft <= 0) {
      this.finishMatch();
      return;
    }
    // Advance the fruit mix on a timer rather than on a quota, so both players
    // are always looking at the same level however differently they are doing.
    if (elapsedInLevel >= VERSUS_LEVEL_SECONDS) this.beginLevel(this.levelIndex + 1);
  }

  private finishMatch() {
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem('fruity.best', String(this.best));
    }
    this.sfx.gameOver();
    this.onMatchOver?.(this.score);
    // Reading `remote` at display time rather than now means a `done` arriving
    // while the blender runs is already reflected when the panel appears.
    this.startSmoothie(() => this.hud.showVersusResult(this.score, this.remote));
  }

  // ------------------------------------------------------------- interaction

  private resolveHands(hands: ScreenHand[], now: number) {
    const H = this.height;

    for (const hand of hands) {
      const sword = this.swordFor(hand, now);
      this.trail(hand, now, sword.hot, sword.x2, sword.y2);
      if (!sword.hot) continue;
      this.sfxWhoosh(now);

      const hitRadius = H * HIT_PAD;

      for (const fruit of this.fruits) {
        if (fruit.state !== 'flying') continue;
        if (this.bladeDistance(fruit, hand, sword, now) > fruit.radius + hitRadius) continue;

        if (fruit.def.id === 'bomb') {
          this.detonate(fruit);
          return;
        }
        this.destroy(fruit, sword);
      }
    }
  }

  /**
   * Resolves the sword's pose for this frame and decides whether it is cutting.
   *
   * `hot` uses a short trailing window rather than a bare speed test: the
   * tracker only samples ~24 times a second, so a genuine swing can dip below
   * threshold between samples. Without the window those frames silently drop
   * the cut, which reads as the game ignoring you.
   */
  private swordFor(hand: ScreenHand, now: number): SwordPose {
    const H = this.height;
    const length = clamp(hand.radius * 2.6, H * 0.16, H * 0.3);

    let state = this.swords.get(hand.id);
    if (!state) {
      state = { hotUntil: 0, x1: hand.x, y1: hand.y, x2: hand.x, y2: hand.y };
      this.swords.set(hand.id, state);
    }

    const seg = bladeSegment(hand.x, hand.y, hand.dirX, hand.dirY, length);
    // Frame-to-frame travel catches quick flicks that the filtered sample
    // velocity smooths away; take whichever reads faster.
    const frameSpeed = Math.hypot(hand.x - hand.prevX, hand.y - hand.prevY) / (1 / 60);
    const speed = Math.max(hand.speed, frameSpeed);
    if (speed > SLICE_SPEED * H) state.hotUntil = now + HOT_WINDOW;

    const pose: SwordPose = {
      length,
      hot: now < state.hotUntil,
      x1: seg.x1,
      y1: seg.y1,
      x2: seg.x2,
      y2: seg.y2,
      prevX1: state.x1,
      prevY1: state.y1,
      prevX2: state.x2,
      prevY2: state.y2,
      speed,
    };

    state.x1 = seg.x1;
    state.y1 = seg.y1;
    state.x2 = seg.x2;
    state.y2 = seg.y2;
    return pose;
  }

  /**
   * Distance from a fruit to everything that counts as "the blade right now":
   * the current edge, the previous edge, the paths traced by the tip and hilt,
   * and — most importantly — the recent arc the player can actually see.
   *
   * Including the drawn arc is what makes this feel fair. Tracking latency puts
   * the sword slightly behind the hand, so a hitbox built only from the current
   * frame asks the player to lead the fruit by an invisible margin.
   */
  private bladeDistance(fruit: Fruit, hand: ScreenHand, s: SwordPose, now: number): number {
    const p = pointSegmentDistance;
    let best = Math.min(
      p(fruit.x, fruit.y, s.x1, s.y1, s.x2, s.y2),
      p(fruit.x, fruit.y, s.prevX1, s.prevY1, s.prevX2, s.prevY2),
      p(fruit.x, fruit.y, s.prevX2, s.prevY2, s.x2, s.y2),
      p(fruit.x, fruit.y, hand.prevX, hand.prevY, hand.x, hand.y),
    );
    const arc = this.blades.get(hand.id);
    if (arc) best = Math.min(best, arc.distanceTo(fruit.x, fruit.y, now));
    return best;
  }

  /** The ribbon streams off the sword tip, not the hand. */
  private trail(hand: ScreenHand, now: number, active: boolean, tipX: number, tipY: number) {
    let blade = this.blades.get(hand.id);
    if (!blade) {
      blade = new Blade();
      this.blades.set(hand.id, blade);
    }
    if (active) blade.push(tipX, tipY, now);
    else blade.prune(now);
  }

  private lastWhoosh = 0;
  private sfxWhoosh(now: number) {
    if (now - this.lastWhoosh > 220) {
      this.lastWhoosh = now;
      this.sfx.whoosh();
    }
  }

  private destroy(fruit: Fruit, sword: SwordPose) {
    const def = fruit.def;
    this.destroyed++;

    this.combo++;
    this.comboTimer = COMBO_WINDOW;
    const multiplier = this.combo >= 2 ? this.combo : 1;
    const gained = def.points * multiplier;
    this.score += gained;

    // Cut along the blade's own axis, so the halves fall apart exactly where
    // the sword passed through rather than along the hand's travel.
    const dirAngle = Math.atan2(sword.y2 - sword.y1, sword.x2 - sword.x1);
    const cutAngle = dirAngle - fruit.rot;
    const nx = -Math.sin(dirAngle);
    const ny = Math.cos(dirAngle);
    const sep = (140 + Math.min(sword.speed * 0.07, 200)) / Math.max(0.7, def.mass * 0.7);

    this.spawnChunk(fruit, cutAngle, -1, -nx * sep, -ny * sep - 50);
    this.spawnChunk(fruit, cutAngle, 1, nx * sep, ny * sep - 50);

    this.fx.burst(fruit.x, fruit.y, 24, def.juice, def.juice2, {
      speed: 500,
      angle: dirAngle,
      spread: 1.1,
      size: fruit.radius * 0.13,
    });
    this.fx.burst(fruit.x, fruit.y, 24, def.juice, def.juice2, {
      speed: 500,
      angle: dirAngle + Math.PI,
      spread: 1.1,
      size: fruit.radius * 0.13,
    });
    this.fx.splat(fruit.x, fruit.y, fruit.radius * 0.9, def.juice);
    this.sfx.slice(def.mass);
    this.shake = Math.max(this.shake, 0.16);
    fruit.state = 'dead';

    if (multiplier > 1) {
      this.fx.popup(
        fruit.x,
        fruit.y - fruit.radius,
        `${multiplier}× ${gained}`,
        '#ffe27a',
        26 + Math.min(multiplier, 6) * 3,
      );
      this.sfx.combo(this.combo);
    } else {
      this.fx.popup(fruit.x, fruit.y - fruit.radius, `+${gained}`, SLICE_COLOR, 22);
    }

    this.hud.setScore(this.score, this.combo);
    this.hud.setProgress(this.destroyed, this.level.quota);
    this.onScoreChanged?.(this.score, this.combo);
    this.platter.add(def.id);
    this.onFruitCut?.(fruit.uid, dirAngle, def.id);

    // In versus the level rotates on the match clock instead, so both players
    // always face the same fruit.
    if (this.mode === 'solo' && this.destroyed >= this.level.quota) this.completeLevel();
  }

  /**
   * The other player cut this fruit, so it leaves our board too.
   *
   * No points and no combo: we score only our own cuts. If we were mid-swing
   * and cut it locally a moment before this arrived, we already scored it, so
   * a fruit contested within the round trip counts for both of us and network
   * lag can never take one away.
   */
  applyRemoteCut(uid: number, angle: number, fruitId: FruitId) {
    // Their platter grows whether or not we still had the fruit: if we cut it
    // a moment earlier, they still earned it on their own screen.
    this.remotePlatter.add(fruitId);

    const fruit = this.fruits.find((f) => f.state === 'flying' && f.uid === uid);
    if (!fruit) return;

    const def = fruit.def;
    const cutAngle = angle - fruit.rot;
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    const sep = 150 / Math.max(0.7, def.mass * 0.7);
    this.spawnChunk(fruit, cutAngle, -1, -nx * sep, -ny * sep - 50);
    this.spawnChunk(fruit, cutAngle, 1, nx * sep, ny * sep - 50);

    this.fx.burst(fruit.x, fruit.y, 14, def.juice, def.juice2, {
      speed: 380,
      angle,
      spread: 1.4,
      size: fruit.radius * 0.11,
    });
    // Their colour, so it is obvious who got it.
    this.fx.ring(fruit.x, fruit.y, fruit.radius * 0.5, fruit.radius * 1.9, GHOST_COLOR, 0.35, 4);
    this.sfx.slice(def.mass * 1.4);
    fruit.state = 'dead';
  }

  private spawnChunk(fruit: Fruit, cutAngle: number, side: 1 | -1, vx: number, vy: number) {
    const chunk = this.chunks.find((c) => !c.alive);
    if (!chunk) return;
    chunk.spawn(
      fruit.def,
      fruit.x,
      fruit.y,
      fruit.vx + vx,
      fruit.vy + vy,
      fruit.radius,
      cutAngle,
      side,
      fruit.rot,
    );
  }

  private detonate(bomb: Fruit) {
    bomb.state = 'dead';
    this.fx.ring(bomb.x, bomb.y, bomb.radius, Math.max(this.width, this.height) * 0.8, '#ff8a3d', 0.6, 10);
    this.fx.burst(bomb.x, bomb.y, 70, '#ffb03a', '#ff4d2e', {
      speed: 900,
      spread: Math.PI * 2,
      size: bomb.radius * 0.2,
      gravity: 0.7,
    });
    this.sfx.explode();
    this.shake = 1;
    this.combo = 0;

    // Everything on screen goes with it.
    for (const f of this.fruits) {
      if (f.state !== 'flying') continue;
      this.fx.burst(f.x, f.y, 10, f.def.juice, f.def.juice2, { speed: 420, size: f.radius * 0.12 });
      f.state = 'dead';
    }

    if (this.mode === 'versus') {
      // Nobody gets knocked out of a race — a bomb costs points and the combo.
      this.score = Math.max(0, this.score - BOMB_PENALTY);
      this.fx.popup(bomb.x, bomb.y, `-${BOMB_PENALTY}`, '#ff6b6b', 30);
      this.hud.setScore(this.score, this.combo);
      this.onScoreChanged?.(this.score, this.combo);
      return;
    }
    this.loseLife('Bomb!');
  }

  private onMiss(x: number) {
    this.combo = 0;
    const px = clamp(x, 60, this.width - 60);
    this.sfx.miss();
    if (this.mode === 'versus') {
      // A fixed-length race stays fair only if both players get the whole
      // match; missing costs the combo, which is punishment enough.
      this.fx.popup(px, this.height - 70, 'MISS', 'rgba(255,255,255,0.55)', 20);
      this.hud.setScore(this.score, this.combo);
      return;
    }
    // The opening level is a practice round — dying there teaches nothing
    // except that the game is unfair.
    if (this.level.forgiving) {
      this.fx.popup(px, this.height - 70, 'MISS', 'rgba(255,255,255,0.5)', 20);
      return;
    }
    this.fx.popup(px, this.height - 70, 'MISS', '#ff6b6b', 22);
    this.loseLife('Missed');
  }

  private loseLife(reason: string) {
    this.lives--;
    this.hud.setLives(this.lives, START_LIVES);
    if (this.lives <= 0) this.endGame(reason);
  }

  private completeLevel() {
    this.phase = 'levelClear';
    this.phaseTimer = 2.4;
    this.combo = 0;
    // A life back per level clear keeps long runs viable.
    if (this.lives < START_LIVES) {
      this.lives++;
      this.hud.setLives(this.lives, START_LIVES);
    }
    this.sfx.levelUp();
    this.hud.showLevelClear(this.level, this.score);
  }

  private endGame(reason: string) {
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem('fruity.best', String(this.best));
    }
    this.sfx.gameOver();
    this.startSmoothie(() =>
      this.hud.showGameOver(this.score, this.best, this.levelIndex, reason),
    );
  }

  // --------------------------------------------------------------- the finale

  /**
   * Tips every bowl into the blender before showing the result.
   *
   * In a two-player match both bowls go into the same jar, so the match ends on
   * something the two of them made rather than on a scoreboard. The result
   * panel is held in `afterSmoothie` and shown when the blender finishes.
   */
  private startSmoothie(showResult: () => void) {
    const mine = this.platter.contents();
    const theirs = this.mode === 'versus' ? this.remotePlatter.contents() : [];
    if (!mine.length && !theirs.length) {
      this.phase = 'gameOver';
      showResult();
      return;
    }

    const { left, right, baseY } = this.platterLayout();
    const origins =
      this.mode === 'versus'
        ? [
            { x: left, y: baseY },
            { x: right, y: baseY },
          ]
        : [{ x: left, y: baseY }];

    // Interleaved so the two bowls empty together rather than one after the
    // other, and so the colours go in mixed.
    const items: FruitId[] = [];
    for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
      if (i < mine.length) items.push(mine[i]);
      if (i < theirs.length) items.push(theirs[i]);
    }

    const caption =
      this.mode === 'versus' ? `You + ${this.remote.name}` : 'Everything you sliced';

    this.phase = 'smoothie';
    this.afterSmoothie = showResult;
    this.landedSoFar = 0;
    this.clearBoard();
    this.hud.hideOverlay();
    this.smoothie.start(items, origins, caption, this.width, this.height);
  }

  private tickSmoothie(dt: number, now: number, hands: ScreenHand[]) {
    const before = this.smoothie.stage;
    this.smoothie.update(dt);
    const after = this.smoothie.stage;
    if (before !== after) this.onSmoothieStage(after);

    // One plop per arrival, throttled — a full bowl lands two dozen pieces
    // inside a second and a half, which without this is a machine gun.
    if (this.smoothie.landed > this.landedSoFar) {
      this.landedSoFar = this.smoothie.landed;
      if (now - this.lastPlopAt > 80) {
        this.lastPlopAt = now;
        this.sfx.plop(0.6 + Math.random() * 0.8);
      }
    }

    // A swung sword over the jar shakes it too, so a camera player is not shut
    // out of the one interactive thing on the screen.
    for (const hand of hands) {
      const sword = this.swordFor(hand, now);
      this.trail(hand, now, false, sword.x2, sword.y2);
      if (!sword.hot || now - this.lastHandShakeAt < 220) continue;
      if (!this.smoothie.hits(sword.x2, sword.y2) && !this.smoothie.hits(hand.x, hand.y)) continue;
      this.lastHandShakeAt = now;
      if (this.shakeSmoothie()) this.onSmoothieShake?.();
    }

    if (after === 'done') {
      this.phase = 'gameOver';
      const show = this.afterSmoothie;
      this.afterSmoothie = null;
      show?.();
    }
  }

  private onSmoothieStage(stage: SmoothieStage) {
    if (stage === 'blend') {
      this.sfx.motorStart();
    } else if (stage === 'pour') {
      this.sfx.motorStop();
      this.sfx.glug();
    } else if (stage === 'done') {
      this.sfx.motorStop();
      this.sfx.chime();
    }
  }

  /**
   * Someone tapped the jar. Returns whether the shake landed, so only a real
   * one is forwarded to the other player. Remote shakes arrive here with no
   * coordinates — the hit test already happened on their screen.
   */
  shakeSmoothie(): boolean {
    if (this.phase !== 'smoothie') return false;
    if (!this.smoothie.shake()) return false;
    this.sfx.rattle();
    this.sfx.motorRev();
    this.shake = Math.max(this.shake, 0.3);
    return true;
  }

  // --------------------------------------------------------------- rendering

  private render(now: number, hands: ScreenHand[], dt: number) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    ctx.save();
    if (this.shake > 0) {
      const s = this.shake * this.shake * 22;
      ctx.translate(rand(-s, s), rand(-s, s));
    }

    if (this.quality) this.fx.drawSplats(ctx, dt);

    for (const c of this.chunks) c.draw(ctx, this.dpr);
    for (const f of this.fruits) {
      if (f.alive) this.drawFruit(ctx, f);
    }

    this.fx.draw(ctx);
    // The bowls have been tipped into the jar by now, so drawing them would
    // show the fruit in two places at once.
    if (this.phase === 'smoothie') this.smoothie.draw(ctx, this.dpr);
    else this.drawPlatters(ctx);

    if (this.mode === 'versus') this.drawGhost(ctx, now);
    for (const hand of hands) this.drawHand(ctx, hand, now);

    ctx.restore();

    if (this.showDebug) this.drawDebug(ctx);
  }

  /**
   * Bowls live in the bottom corners rather than across the middle: the centre
   * of the screen is where fruit falls, and the "show your hand" prompt sits
   * along the bottom edge.
   */
  /** Shared by the bowls and by the smoothie, which flies fruit out of them. */
  private platterLayout() {
    const H = this.height;
    const W = this.width;
    const w = clamp(Math.min(W * 0.15, H * 0.26), 90, 260);
    const inset = W * 0.035 + w * 0.5;
    return { w, baseY: H - H * 0.075, left: inset, right: W - inset };
  }

  private drawPlatters(ctx: CanvasRenderingContext2D) {
    const { w, baseY, left: inset, right: rightX } = this.platterLayout();

    if (this.mode === 'solo') {
      this.platter.draw(ctx, inset, baseY, w, this.dpr, SLICE_COLOR);
      const n = this.platter.count;
      this.platterLabel(ctx, inset, baseY, w, n ? `${n} sliced` : '', SLICE_COLOR);
      return;
    }

    this.platter.draw(ctx, inset, baseY, w, this.dpr, SLICE_COLOR);
    this.platterLabel(ctx, inset, baseY, w, `You  ${this.score}`, SLICE_COLOR);

    this.remotePlatter.draw(ctx, rightX, baseY, w, this.dpr, GHOST_COLOR);
    // Connection trouble is reported here now that the opponent card is gone.
    const theirLabel = this.remote.connected
      ? `${this.remote.name}  ${this.remote.score}`
      : `${this.remote.name}  reconnecting…`;
    this.platterLabel(ctx, rightX, baseY, w, theirLabel, GHOST_COLOR);
  }

  private platterLabel(
    ctx: CanvasRenderingContext2D,
    cx: number,
    baseY: number,
    w: number,
    text: string,
    colour: string,
  ) {
    if (!text) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `800 ${Math.round(clamp(w * 0.17, 13, 26))}px ui-rounded, "Avenir Next", system-ui, sans-serif`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.strokeText(text, cx, baseY + w * 0.08);
    ctx.fillStyle = colour;
    ctx.fillText(text, cx, baseY + w * 0.08);
    ctx.restore();
  }

  private drawFruit(ctx: CanvasRenderingContext2D, fruit: Fruit) {
    if (fruit.def.id === 'bomb') {
      // Pulsing danger halo — a black sphere against a dark camera feed is easy
      // to lose, and it is the one thing the player must never touch.
      const pulse = 0.5 + 0.5 * Math.sin(fruit.age * 9);
      ctx.save();
      ctx.globalAlpha = 0.25 + pulse * 0.4;
      ctx.beginPath();
      ctx.arc(fruit.x, fruit.y, fruit.radius * (1.18 + pulse * 0.14), 0, Math.PI * 2);
      ctx.strokeStyle = '#ff5470';
      ctx.lineWidth = 2 + pulse * 2.5;
      ctx.stroke();
      ctx.restore();
    }
    fruit.draw(ctx, this.dpr);
  }

  /**
   * The opponent's sword, drawn on your board. Their fruit is identical to
   * yours, so watching their arc actually means something — you can see them
   * going for the same watermelon.
   */
  private drawGhost(ctx: CanvasRenderingContext2D, now: number) {
    const h = this.remote.hand;
    if (!h || now - this.remote.handAt > GHOST_STALE_MS) {
      this.remoteBlade.prune(now);
      return;
    }

    const x = h.x * this.width;
    const y = h.y * this.height;
    const length = clamp(h.len * this.height, this.height * 0.12, this.height * 0.34);
    const seg = bladeSegment(x, y, h.dx, h.dy, length);

    if (h.hot) this.remoteBlade.push(seg.x2, seg.y2, now);
    else this.remoteBlade.prune(now);

    ctx.save();
    // Ghosted so it never competes with the player's own sword for attention.
    ctx.globalAlpha = 0.5;
    this.remoteBlade.draw(ctx, now, GHOST_COLOR, Math.max(18, length * 0.34));
    ctx.globalAlpha = h.hot ? 0.62 : 0.4;
    drawSword(ctx, x, y, Math.atan2(h.dy, h.dx), length, this.dpr, false, GHOST_TINT);
    ctx.restore();
  }

  private drawHand(ctx: CanvasRenderingContext2D, hand: ScreenHand, now: number) {
    const sword = this.swords.get(hand.id);
    const blade = this.blades.get(hand.id);
    // Wide, but drawn soft and translucent by Blade.draw. Width is what shows
    // the player where they actually swung; opacity is what keeps it from
    // competing with the sword itself.
    if (blade) blade.draw(ctx, now, SLICE_COLOR, Math.max(22, hand.radius * 1.05));
    if (!sword) return;

    const hot = now < sword.hotUntil;
    const angle = Math.atan2(sword.y2 - sword.y1, sword.x2 - sword.x1);
    const length = Math.hypot(sword.x2 - sword.x1, sword.y2 - sword.y1) / 0.9;

    // A soft disc under the grip keeps the hand locatable even when the sword
    // is edge-on to the camera and nearly disappears.
    ctx.save();
    ctx.globalAlpha = hot ? 0.22 : 0.12;
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, hand.radius * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = SLICE_COLOR;
    ctx.fill();
    ctx.restore();

    drawSword(ctx, hand.x, hand.y, angle, length, this.dpr, hot);
  }

  private drawDebug(ctx: CanvasRenderingContext2D) {
    const s = this.tracker.stats;
    const lines = [
      `frame ${this.avgFrameMs.toFixed(1)}ms (${(1000 / this.avgFrameMs).toFixed(0)} fps)`,
      `infer ${s.inferenceMs.toFixed(1)}ms @ ${s.trackerHz.toFixed(1)}Hz (aim ${s.targetHz.toFixed(0)}, cam ${s.cameraHz.toFixed(0)})`,
      `${s.mode} / ${s.delegate} / hands ${s.handsVisible}`,
      `quality ${this.quality} · dpr ${this.dpr}`,
      `fruit ${this.fruits.filter((f) => f.alive).length} · chunks ${this.chunks.filter((c) => c.alive).length}`,
      `cut above ${(SLICE_SPEED * this.height).toFixed(0)} px/s · hot ${HOT_WINDOW}ms`,
    ];
    if (this.mode === 'versus') lines.push(`net ${this.netRoute?.() ?? '—'}`);
    // Sits below the HUD so it doesn't cover the score.
    const top = 116;
    ctx.save();
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(10, top, 258, lines.length * 16 + 12);
    ctx.fillStyle = '#7dffb2';
    lines.forEach((l, i) => ctx.fillText(l, 20, top + 8 + i * 16));
    ctx.restore();
  }
}
