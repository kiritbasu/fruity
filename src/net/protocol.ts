/** Wire format between the two peers. Kept as JSON — at 30Hz this is ~3 KB/s,
 *  which is noise next to the video call the players are already on. */

export type Role = 'host' | 'guest';

/** Sent ~30 times a second on the unreliable channel. */
export interface HandMsg {
  t: 'hand';
  /** Normalised 0..1 so it maps correctly onto a differently sized window. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Sword length as a fraction of viewport height. */
  len: number;
  /** Whether the blade is currently cutting. */
  hot: 0 | 1;
}

/** Sent on score changes over the reliable channel. */
export interface ScoreMsg {
  t: 'score';
  score: number;
  combo: number;
}

export interface StartMsg {
  t: 'start';
  seed: number;
  /** Match length in seconds. */
  duration: number;
}

export interface HelloMsg {
  t: 'hello';
  name: string;
  /** True if this peer is sending a camera track. */
  video: boolean;
}

/** One player cut a fruit; it leaves both boards. */
export interface CutMsg {
  t: 'cut';
  /** Deterministic fruit id, agreed by both sides without being negotiated. */
  uid: number;
  /** Angle of the cut, so the halves fall apart the same way on both screens. */
  a: number;
  /** Which fruit it was. Sent rather than looked up, because the local slot may
   *  already have been recycled by a later spawn. */
  f: string;
}

export interface DoneMsg {
  t: 'done';
  score: number;
}

export interface ByeMsg {
  t: 'bye';
}

export type NetMsg = HandMsg | ScoreMsg | StartMsg | HelloMsg | CutMsg | DoneMsg | ByeMsg;

/** Mirror of the opponent, as the game renders it. */
export interface RemoteState {
  connected: boolean;
  name: string;
  score: number;
  combo: number;
  done: boolean;
  /** Latest hand, in normalised coordinates. */
  hand: { x: number; y: number; dx: number; dy: number; len: number; hot: boolean } | null;
  /** performance.now() of the last hand packet, for staleness. */
  handAt: number;
}

export const emptyRemote = (): RemoteState => ({
  connected: false,
  name: 'Opponent',
  score: 0,
  combo: 0,
  done: false,
  hand: null,
  handAt: 0,
});
