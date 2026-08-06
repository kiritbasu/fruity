import { escapeHtml } from '../util/html';
import type { LevelDef } from './levels';
import type { PeerStatus } from '../net/Peer';
import type { RemoteState } from '../net/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface HudCallbacks {
  onRestart: () => void;
  onResume: () => void;
  onRematch?: () => void;
}

/**
 * Score, lives and overlays live in the DOM rather than the canvas: text stays
 * crisp at any DPR and costs nothing per frame, which matters when the frame
 * budget is already going to camera inference.
 */
export class Hud {
  private hud = $<HTMLElement>('hud');
  private scoreEl = $<HTMLElement>('score');
  private bestEl = $<HTMLElement>('best');
  private comboEl = $<HTMLElement>('combo');
  private livesEl = $<HTMLElement>('lives');
  private levelNameEl = $<HTMLElement>('levelName');
  private progressBar = $<HTMLElement>('progressBar');
  private progressText = $<HTMLElement>('progressText');
  private overlay = $<HTMLElement>('overlay');
  private panel = $<HTMLElement>('panel');
  private handWarning = $<HTMLElement>('handWarning');
  private soundBtn = $<HTMLButtonElement>('soundBtn');
  private opponent = $<HTMLElement>('opponent');
  private oppName = $<HTMLElement>('oppName');
  private oppScore = $<HTMLElement>('oppScore');
  private oppState = $<HTMLElement>('oppState');
  private oppVideo = $<HTMLVideoElement>('oppVideo');
  private clock = $<HTMLElement>('matchClock');
  private clockBar = $<HTMLElement>('matchClockBar');

  private handMissingSince = 0;
  private warningVisible = false;

  constructor(private cb: HudCallbacks) {
    this.panel.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.dataset.action === 'restart') this.cb.onRestart();
      if (target.dataset.action === 'resume') this.cb.onResume();
      if (target.dataset.action === 'rematch') this.cb.onRematch?.();
    });
  }

  private soundOn = true;
  private soundListener: ((enabled: boolean) => void) | null = null;

  onSoundToggle(fn: (enabled: boolean) => void) {
    this.soundListener = fn;
    this.soundBtn.addEventListener('click', () => this.toggleSound());
  }

  toggleSound() {
    this.soundOn = !this.soundOn;
    this.soundBtn.textContent = this.soundOn ? '🔊' : '🔇';
    this.soundListener?.(this.soundOn);
  }

  showHud(best: number) {
    this.hud.hidden = false;
    this.bestEl.textContent = String(best);
  }

  setScore(score: number, combo: number) {
    this.scoreEl.textContent = String(score);
    if (combo >= 2) {
      this.comboEl.textContent = `${combo}× COMBO`;
      this.comboEl.classList.add('on');
    } else {
      this.comboEl.classList.remove('on');
    }
  }

  setLives(lives: number, max = 5) {
    this.livesEl.replaceChildren();
    for (let i = 0; i < max; i++) {
      const s = document.createElement('span');
      s.textContent = '🍏';
      if (i >= lives) s.className = 'lost';
      this.livesEl.append(s);
    }
  }

  setProgress(done: number, quota: number) {
    this.progressBar.style.width = `${Math.min(100, (done / quota) * 100)}%`;
    this.progressText.textContent = `${done} / ${quota}`;
  }

  /** Swaps the "no input" nag to match whichever source is driving the game. */
  setInputMode(mode: 'camera' | 'pointer') {
    this.handWarning.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'dot';
    this.handWarning.append(
      dot,
      mode === 'camera' ? 'Show your hand to the camera' : 'Move your mouse over the window',
    );
  }

  setHandPresent(present: boolean) {
    const now = performance.now();
    if (present) {
      this.handMissingSince = 0;
      if (this.warningVisible) {
        this.handWarning.hidden = true;
        this.warningVisible = false;
      }
      return;
    }
    if (!this.handMissingSince) this.handMissingSince = now;
    // Only nag after a beat — hands drop out for a frame all the time.
    if (!this.warningVisible && now - this.handMissingSince > 900) {
      this.handWarning.hidden = false;
      this.warningVisible = true;
    }
  }

  // ------------------------------------------------------------- multiplayer

  /** Swaps the HUD between the solo level display and the versus race panel. */
  setVersusChrome(on: boolean) {
    this.opponent.hidden = !on;
    this.clock.hidden = !on;
    // A timed race has no elimination, so lives would be misleading.
    this.livesEl.hidden = on;
    // Level progress is meaningless in a timed race — the clock replaces it.
    this.progressBar.parentElement!.hidden = on;
    this.progressText.hidden = on;
  }

  setOpponent(remote: RemoteState) {
    this.oppName.textContent = remote.name;
    this.oppScore.textContent = String(remote.score);
    this.oppState.textContent = remote.done ? 'finished' : remote.connected ? '' : 'reconnecting…';
  }

  setPeerStatus(status: PeerStatus, detail?: string) {
    if (status === 'connected') this.oppState.textContent = '';
    else if (status === 'connecting') this.oppState.textContent = 'connecting…';
    else this.oppState.textContent = detail ?? status;
  }

  setOpponentStream(stream: MediaStream | null) {
    if (!stream) {
      this.oppVideo.srcObject = null;
      this.oppVideo.hidden = true;
      return;
    }
    this.oppVideo.srcObject = stream;
    this.oppVideo.hidden = false;
    void this.oppVideo.play().catch(() => {});
  }

  setMatchClock(secondsLeft: number, total: number) {
    const s = Math.ceil(secondsLeft);
    this.clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.clockBar.style.width = `${Math.max(0, (secondsLeft / total) * 100)}%`;
    this.clock.classList.toggle('urgent', secondsLeft <= 15);
  }

  showVersusResult(score: number, remote: RemoteState) {
    const win = score > remote.score;
    const draw = score === remote.score;
    // Sanitised on arrival too; escaped again here so this template is safe on
    // its own terms rather than by trusting a caller three modules away.
    const name = escapeHtml(remote.name);
    const title = draw ? 'Dead heat' : win ? 'You win' : `${name} wins`;
    this.show(`
      <div class="kicker">Match over</div>
      <h2>${title}</h2>
      <div class="stats">
        <div class="stat"><b>${score}</b><small>You</small></div>
        <div class="stat"><b>${Number(remote.score) || 0}</b><small>${name}</small></div>
      </div>
      <p class="hint">${
        remote.done ? 'You both finished.' : 'Waiting for them to finish…'
      }</p>
      <button class="primary" data-action="rematch">Rematch</button>
      <button class="ghost" data-action="restart">Back to solo</button>
    `);
  }

  // ----------------------------------------------------------- overlay views

  private show(html: string, transparent = false) {
    this.panel.innerHTML = html;
    this.overlay.hidden = false;
    this.overlay.classList.toggle('transparent', transparent);
  }

  hideOverlay() {
    this.overlay.hidden = true;
  }

  showLoading(message: string) {
    this.show(`
      <h1><span class="melon">🍉</span> Fruity</h1>
      <p>Slice fruit by waving your hand at the camera.</p>
      <div class="loader"><span class="spinner"></span><span>${message}</span></div>
    `);
  }

  showError(title: string, detail: string) {
    this.show(`
      <h2>${title}</h2>
      <div class="error">${detail}</div>
      <button class="primary" data-action="restart">Try again</button>
      <div class="foot">
        Or <a href="#" data-action="pointer" class="link">play with the mouse instead</a>
      </div>
    `);
  }

  showLevelCard(level: LevelDef) {
    this.levelNameEl.textContent = level.name;
    this.setProgress(0, level.quota);
    this.show(
      `
      <div class="kicker">Level ${level.index + 1}</div>
      <h2>${level.name}</h2>
      <p class="tight">${level.brief}</p>
      <p class="hint">${level.quota} fruit to clear</p>
    `,
      true,
    );
  }

  showLevelClear(level: LevelDef, score: number) {
    this.show(
      `
      <div class="kicker">Cleared</div>
      <h2>${level.name}</h2>
      <p>Score <b>${score}</b> · +1 life</p>
    `,
      true,
    );
  }

  showPaused() {
    this.show(`
      <h2>Paused</h2>
      <p>Take your time.</p>
      <button class="primary" data-action="resume">Resume</button>
    `);
  }

  showGameOver(score: number, best: number, level: number, reason: string) {
    const record = score >= best && score > 0;
    this.show(`
      <div class="kicker">${reason}</div>
      <h2>${record ? 'New best!' : 'Game over'}</h2>
      <div class="stats">
        <div class="stat"><b>${score}</b><small>Score</small></div>
        <div class="stat"><b>${best}</b><small>Best</small></div>
        <div class="stat"><b>${level + 1}</b><small>Level</small></div>
      </div>
      <button class="primary" data-action="restart">Play again</button>
      <div class="foot">
        <kbd>2</kbd> play with a friend · <kbd>D</kbd> stats · <kbd>M</kbd> sound
      </div>
    `);
  }

  /** Raw access for the tutorial screen, which manages its own markup. */
  get panelEl() {
    return this.panel;
  }

  showRaw(html: string) {
    this.show(html);
  }
}
