import { Peer, type PeerStatus } from './Peer';
import type { NetMsg, Role } from './protocol';
import { safeLabel, safeNumber } from '../util/html';
import type { Game } from '../game/Game';
import type { Hud } from '../game/hud';

/** Length of a versus match, in seconds. */
export const MATCH_SECONDS = 180;

/**
 * Owns the multiplayer lifecycle: wires the peer connection to the game, keeps
 * the opponent mirror up to date, and coordinates match start.
 *
 * Deliberately thin. The only things that cross the network are a seed, hand
 * positions and scores — the fruit itself is generated independently on both
 * sides from that shared seed, so there is no world state to reconcile and
 * network latency cannot make the race unfair.
 */
export class Session {
  readonly peer: Peer;
  role: Role = 'host';

  constructor(
    private game: Game,
    private hud: Hud,
    private onStatus: (status: PeerStatus, detail?: string) => void,
    turnServers: RTCIceServer[] = [],
  ) {
    this.peer = new Peer(
      {
        onMessage: (m) => this.handle(m),
        onStatus: (s, d) => {
          this.game.remote.connected = s === 'connected';
          this.hud.setPeerStatus(s, d);
          this.onStatus(s, d);
        },
        onRemoteStream: (stream) => this.hud.setOpponentStream(stream),
      },
      turnServers,
    );

    this.game.onLocalHand = (h) =>
      this.peer.send({
        t: 'hand',
        x: h.x,
        y: h.y,
        dx: h.dx,
        dy: h.dy,
        len: h.len,
        hot: h.hot ? 1 : 0,
      });

    this.game.onScoreChanged = (score, combo) => this.peer.send({ t: 'score', score, combo });

    this.game.onMatchOver = (score) => {
      this.peer.send({ t: 'done', score });
      this.hud.setOpponent(this.game.remote);
    };
  }

  /**
   * Everything arriving on the data channel is untrusted. The peer is whoever
   * holds the room code, and the payload is raw JSON, so each field is coerced
   * to its expected type and range here rather than at the point of use — one
   * boundary to audit instead of every render path.
   */
  private handle(msg: NetMsg) {
    const remote = this.game.remote;
    switch (msg.t) {
      case 'hello':
        remote.name = safeLabel(msg.name, 24, 'Opponent');
        this.hud.setOpponent(remote);
        break;

      case 'hand':
        // Clamped generously — off-screen is legal, infinities and NaN are not,
        // and a NaN would silently poison the ghost's rendering maths.
        remote.hand = {
          x: safeNumber(msg.x, -1, 2),
          y: safeNumber(msg.y, -1, 2),
          dx: safeNumber(msg.dx, -1, 1),
          dy: safeNumber(msg.dy, -1, 1),
          len: safeNumber(msg.len, 0, 1, 0.2),
          hot: !!msg.hot,
        };
        remote.handAt = performance.now();
        break;

      case 'score':
        remote.score = Math.round(safeNumber(msg.score, 0, 1e9));
        remote.combo = Math.round(safeNumber(msg.combo, 0, 999));
        this.hud.setOpponent(remote);
        break;

      case 'start':
        // The guest never picks the seed; it just runs whatever the host chose.
        this.beginMatch(
          Math.floor(safeNumber(msg.seed, 0, 0xffffffff)),
          safeNumber(msg.duration, 10, 3600, MATCH_SECONDS),
        );
        break;

      case 'done':
        remote.done = true;
        remote.score = Math.round(safeNumber(msg.score, 0, 1e9));
        this.hud.setOpponent(remote);
        // If we already finished, the result panel was showing a provisional
        // score for them; refresh it now that theirs is final.
        if (this.game.phase === 'gameOver') this.hud.showVersusResult(this.game.score, remote);
        break;

      case 'bye':
        remote.connected = false;
        this.hud.setPeerStatus('closed', 'Opponent left');
        break;
    }
  }

  introduce(name: string) {
    this.peer.send({ t: 'hello', name, video: this.peer.videoAvailable });
  }

  /** Host only. Both sides land in beginMatch within a round trip of each other. */
  startMatch() {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.peer.send({ t: 'start', seed, duration: MATCH_SECONDS });
    this.beginMatch(seed, MATCH_SECONDS);
  }

  private beginMatch(seed: number, duration: number) {
    this.game.remote.done = false;
    this.game.remote.score = 0;
    this.hud.setVersusChrome(true);
    this.hud.setOpponent(this.game.remote);
    this.hud.hideOverlay();
    this.game.startVersus(seed, duration);
  }

  close() {
    this.game.onLocalHand = null;
    this.game.onScoreChanged = null;
    this.game.onMatchOver = null;
    this.hud.setVersusChrome(false);
    this.hud.setOpponentStream(null);
    this.peer.close();
  }
}
