import { Session, MATCH_SECONDS } from './Session';
import { fetchIceServers } from './Peer';
import {
  awaitAnswer,
  clearUrlCode,
  createRoom,
  fetchOffer,
  inviteLink,
  submitAnswer,
} from './rooms';
import { errorText, escapeHtml } from '../util/html';
import type { Game } from '../game/Game';
import type { Hud } from '../game/hud';

const STORED_NAME = 'fruity.name';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Two-player lobby.
 *
 * The default path is deliberately lopsided: the host does everything and the
 * guest only taps a link. That asymmetry is the whole design goal — the guest
 * may well be a young child, and the earlier hand-carried exchange asked them
 * to relay an 800-character string *and* send a second one back.
 */
export class Lobby {
  private session: Session | null = null;
  private turnServers: RTCIceServer[] | null = null;
  private cancelled = false;
  /** Whether we are currently sending camera video, owned here so the V key and
   *  the lobby checkbox can never disagree about the state. */
  private videoOn = false;

  constructor(
    private game: Game,
    private hud: Hud,
    private cameraStream: () => MediaStream | null,
    private onExit: () => void,
  ) {}

  private get name() {
    return localStorage.getItem(STORED_NAME) || 'Player';
  }

  private async newSession() {
    this.session?.close();
    this.cancelled = false;
    if (!this.turnServers) this.turnServers = await fetchIceServers();
    const session = new Session(
      this.game,
      this.hud,
      (status, detail) => {
        if (status === 'failed') this.showFailed(detail);
      },
      this.turnServers,
    );
    const stream = this.cameraStream();
    if (stream) session.peer.attachCamera(stream);
    this.session = session;
    return session;
  }

  private on(action: string, fn: () => void) {
    this.hud.panelEl.querySelector(`[data-action="${action}"]`)?.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
  }

  private wantsVideo(): boolean {
    return (
      (this.hud.panelEl.querySelector('#oppVideoOpt') as HTMLInputElement | null)?.checked ?? false
    );
  }

  private exit() {
    this.cancelled = true;
    clearUrlCode();
    this.onExit();
  }

  // ------------------------------------------------------------------ entry

  show() {
    const hasCamera = !!this.cameraStream();
    this.hud.showRaw(`
      <div class="kicker">Two players</div>
      <h2>Play with a friend</h2>
      <p>You both slice <b>the same fruit</b>. Get there first and it's yours.
      Highest score after ${Math.round(MATCH_SECONDS / 60)} minutes wins.</p>
      <div class="opt">
        <label><input type="checkbox" id="oppVideoOpt" ${hasCamera ? '' : 'disabled'} />
        Send my camera too${hasCamera ? '' : ' (needs a webcam)'}</label>
      </div>
      <button class="primary wide" data-action="host">Start a game</button>
      <button class="ghost wide" data-action="join">Join with a code</button>
      <div class="foot">
        <a href="#" data-action="solo" class="link">back to solo</a>
      </div>
    `);
    this.on('host', () => void this.hostFlow(this.wantsVideo()));
    this.on('join', () => this.askForCode(this.wantsVideo()));
    this.on('solo', () => this.exit());
  }

  private showFailed(detail?: string) {
    if (this.cancelled) return;
    this.hud.showRaw(`
      <h2>Could not connect</h2>
      <div class="error">${escapeHtml(detail ?? 'Could not reach the other player.')}${
        this.turnServers?.length
          ? ''
          : '<br /><br />No relay is configured on this deployment, which matters only for networks that block direct connections.'
      }</div>
      <button class="primary" data-action="retry">Try again</button>
      <button class="ghost" data-action="solo">Back to solo</button>
    `);
    this.on('retry', () => this.show());
    this.on('solo', () => this.exit());
  }

  // ------------------------------------------------------------------- host

  private async hostFlow(video: boolean) {
    const session = await this.newSession();
    session.role = 'host';

    this.hud.showRaw(`
      <h2>Setting up…</h2>
      <div class="loader"><span class="spinner"></span><span>Creating your game</span></div>
    `);

    let offer: string;
    try {
      offer = await session.peer.createOffer();
    } catch (err) {
      this.showFailed(errorText(err));
      return;
    }
    this.setVideo(video);
    if (this.cancelled) return;

    let code: string;
    try {
      code = (await createRoom(offer)).code;
    } catch (err) {
      this.showRelayUnavailable(errorText(err));
      return;
    }

    const link = inviteLink(code);
    void copy(link);
    this.hud.showRaw(`
      <div class="kicker">Your game is ready</div>
      <h2>Send them this link</h2>
      <button class="primary wide" data-action="copylink">Copy invite link</button>
      <p class="hint tight">Send it however you like. They tap it and they're in,
      with nothing to type.</p>
      <div class="code-or">or read them this code</div>
      <div class="big-code">${code}</div>
      <div class="loader"><span class="spinner"></span><span>Waiting for them to join…</span></div>
      <div class="foot"><a href="#" data-action="cancel" class="link">cancel</a></div>
    `);
    this.on('copylink', () => {
      void copy(link).then((ok) => {
        const b = this.hud.panelEl.querySelector('[data-action="copylink"]');
        if (b) b.textContent = ok ? 'Link copied ✓' : 'Press ⌘C to copy';
      });
    });
    this.on('cancel', () => {
      // Without this the awaitAnswer poll below keeps running for its full
      // three-minute timeout and can seize the UI long after the player left.
      this.cancelled = true;
      this.session?.close();
      this.session = null;
      this.show();
    });

    try {
      const answer = await awaitAnswer(code, { signal: () => this.cancelled });
      if (this.cancelled) return;
      await session.peer.acceptAnswer(answer);
      this.waitForReady(true);
    } catch (err) {
      if (this.cancelled) return;
      this.showFailed(errorText(err));
    }
  }

  // ------------------------------------------------------------------ guest

  private askForCode(video: boolean) {
    this.hud.showRaw(`
      <div class="kicker">Join a game</div>
      <h2>Enter their code</h2>
      <input class="big-input" id="joinCode" inputmode="numeric" pattern="[0-9]*"
             maxlength="6" placeholder="000000" autocomplete="off" />
      <button class="primary wide" data-action="go">Join</button>
      <div class="foot" id="lobbyErr"></div>
      <div class="foot"><a href="#" data-action="back" class="link">back</a></div>
    `);
    const input = this.hud.panelEl.querySelector('#joinCode') as HTMLInputElement | null;
    input?.focus();
    const submit = () => {
      const code = (input?.value ?? '').trim();
      if (!/^\d{4}$/.test(code)) {
        const err = this.hud.panelEl.querySelector('#lobbyErr') as HTMLElement;
        err.textContent = 'That should be six digits.';
        return;
      }
      void this.joinWithCode(code, video);
    };
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    this.on('go', submit);
    this.on('back', () => this.show());
  }

  /**
   * The whole guest experience. Called directly when the app is opened from an
   * invite link, so for them it is one tap and they are in.
   */
  async joinWithCode(code: string, video = false) {
    this.hud.showRaw(`
      <h2>Joining game ${escapeHtml(code)}</h2>
      <div class="loader"><span class="spinner"></span><span>Connecting…</span></div>
    `);

    const session = await this.newSession();
    session.role = 'guest';

    try {
      const offer = await fetchOffer(code);
      const answer = await session.peer.acceptOffer(offer);
      this.setVideo(video);
      await submitAnswer(code, answer);
      clearUrlCode();
      if (this.cancelled) return;
      this.waitForReady(false);
    } catch (err) {
      this.showJoinFailed(errorText(err));
    }
  }

  private showJoinFailed(detail: string) {
    this.hud.showRaw(`
      <h2>Could not join</h2>
      <div class="error">${escapeHtml(detail)}</div>
      <button class="primary" data-action="retry">Try another code</button>
      <button class="ghost" data-action="solo">Play on my own</button>
    `);
    this.on('retry', () => this.askForCode(false));
    this.on('solo', () => this.exit());
  }

  /**
   * Nothing to fall back to: without a relay the guest would have to hand-carry
   * an 800-character answer back, which is what this whole flow exists to avoid.
   */
  private showRelayUnavailable(detail: string) {
    this.hud.showRaw(`
      <h2>Invites are unavailable</h2>
      <div class="error">${escapeHtml(detail)}<br /><br />We couldn't reach the
      invite service, so a game can't be set up right now.</div>
      <button class="primary" data-action="retry">Try again</button>
      <button class="ghost" data-action="solo">Back to solo</button>
    `);
    this.on('retry', () => this.show());
    this.on('solo', () => this.exit());
  }

  // ----------------------------------------------------------------- shared

  private waitForReady(isHost: boolean) {
    const session = this.session!;
    const deadline = performance.now() + 30_000;

    const tick = () => {
      if (!this.session || this.cancelled) return;
      if (this.game.remote.connected) {
        session.introduce(this.name);
        if (isHost) this.startCountdown();
        else this.showWaitingForHost();
        return;
      }
      if (performance.now() > deadline) {
        this.showFailed('Timed out waiting for the other player.');
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  }

  /**
   * Starts on its own. One fewer button for a child to find, and the host
   * already said what they wanted by creating the game.
   */
  private startCountdown() {
    let n = 3;
    const render = () => {
      if (this.cancelled || !this.session) return;
      if (n <= 0) {
        this.session.startMatch();
        return;
      }
      this.hud.showRaw(`
        <div class="kicker">Connected</div>
        <h2>Starting in ${n}…</h2>
        <p>You're both in. Same fruit, first one to it takes it. Go fast.</p>
        <button class="primary" data-action="now">Start now</button>
      `);
      this.on('now', () => this.session?.startMatch());
      n--;
      setTimeout(render, 1000);
    };
    render();
  }

  private showWaitingForHost() {
    this.hud.showRaw(`
      <div class="kicker">Connected</div>
      <h2>You're in!</h2>
      <p>Hold your hand up. The game starts in a moment.</p>
      <div class="loader"><span class="spinner"></span><span>Get ready</span></div>
    `);
  }

  private setVideo(on: boolean) {
    this.videoOn = on;
    this.session?.peer.setVideoEnabled(on);
  }

  /** Returns the new state so callers can report it. */
  toggleVideo(): boolean {
    this.setVideo(!this.videoOn);
    return this.videoOn;
  }

  rematch() {
    if (this.session?.role === 'host') this.startCountdown();
    else this.showWaitingForHost();
  }

  close() {
    this.cancelled = true;
    this.session?.close();
    this.session = null;
  }
}
