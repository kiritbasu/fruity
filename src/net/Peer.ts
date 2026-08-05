import { decodeSignal, encodeSignal } from './codec';
import type { NetMsg } from './protocol';

/**
 * Free and unlimited. STUN alone gets most home connections talking directly;
 * fetchIceServers() below adds a Cloudflare TURN relay for the rest.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

/** How long to wait for ICE candidates before emitting the code anyway. */
const ICE_TIMEOUT_MS = 4000;

/**
 * How long a 'disconnected' peer is given to heal before we call it a failure.
 * Transient drops of a few seconds are routine and recover by themselves.
 */
const RECOVER_GRACE_MS = 8000;

/** Grace after a usable candidate set arrives, to catch a few more cheaply. */
const ICE_SETTLE_MS = 400;

/**
 * Asks the deployment for Cloudflare TURN credentials, which cover the roughly
 * one connection in five that cannot go peer-to-peer directly.
 *
 * Credentials are minted per session by /api/turn, because the underlying
 * Cloudflare key is a long-term secret that must not reach the browser. If the
 * endpoint is missing (local `vite dev`) or unconfigured, this resolves empty
 * and the connection falls back to STUN — which is enough most of the time.
 */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch('/api/turn', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(data.iceServers) ? data.iceServers : [];
  } catch {
    // Offline, no API route, or an HTML 404 body — STUN only.
    return [];
  }
}

export type PeerStatus = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

export interface PeerEvents {
  onMessage: (msg: NetMsg) => void;
  onStatus: (status: PeerStatus, detail?: string) => void;
  onRemoteStream: (stream: MediaStream) => void;
}

export class Peer {
  private pc: RTCPeerConnection;
  /** Reliable + ordered: scores, match start, disconnects. */
  private stateCh: RTCDataChannel | null = null;
  /** Unordered, no retransmits: hand positions, where a late packet is worse
   *  than a lost one. */
  private inputCh: RTCDataChannel | null = null;
  private videoSender: RTCRtpSender | null = null;
  private status: PeerStatus = 'idle';
  /** Candidate types we managed to gather, for a useful failure message. */
  private localCandidates = new Set<string>();
  private hadRelay = false;
  private recoverTimer = 0;

  constructor(
    private events: PeerEvents,
    turnServers: RTCIceServer[] = [],
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: [...ICE_SERVERS, ...turnServers],
      // Everything shares one transport, so video and data need one negotiation.
      bundlePolicy: 'max-bundle',
    });

    this.pc.onicecandidate = (ev) => {
      const type = ev.candidate?.type;
      if (!type) return;
      this.localCandidates.add(type);
      if (type === 'relay') this.hadRelay = true;
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;

      if (s === 'connected') {
        window.clearTimeout(this.recoverTimer);
        this.recoverTimer = 0;
        this.set('connected');
        return;
      }

      if (s === 'failed') {
        window.clearTimeout(this.recoverTimer);
        this.set('failed', this.diagnose());
        return;
      }

      /*
       * 'disconnected' is not fatal. WebRTC dips into it for a few seconds
       * whenever packets stop arriving — Wi-Fi roaming, a sleeping laptop lid,
       * ordinary loss — and recovers on its own. Treating it as an immediate
       * failure tore the game down mid-match over blips that would have healed.
       */
      if (s === 'disconnected') {
        if (this.recoverTimer) return;
        this.recoverTimer = window.setTimeout(() => {
          this.recoverTimer = 0;
          if (this.pc.connectionState !== 'connected') {
            this.set('failed', 'The connection dropped and did not come back.');
          }
        }, RECOVER_GRACE_MS);
        return;
      }

      if (s === 'closed') this.set('closed');
    };

    this.pc.ontrack = (ev) => {
      if (ev.streams[0]) this.events.onRemoteStream(ev.streams[0]);
    };

    this.pc.ondatachannel = (ev) => this.bind(ev.channel);
  }

  /**
   * Explains *why* a connection failed rather than blaming the relay by
   * default. A LAN failure and a NAT failure need completely different fixes,
   * and a message that always mentions TURN sends you after the wrong one.
   */
  private diagnose(): string {
    const types = [...this.localCandidates];
    if (!types.length) {
      return 'No network routes were found at all — check that the browser is allowed network access.';
    }
    if (!this.hadRelay) {
      return `Could not find a route to the other player (tried: ${types.join(', ')}). No relay candidate was available, so a strict network on either side would block this.`;
    }
    return `Could not find a route to the other player (tried: ${types.join(', ')}). A relay was available, so this is more likely a firewall blocking UDP than a missing relay.`;
  }

  private set(status: PeerStatus, detail?: string) {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus(status, detail);
  }

  private bind(ch: RTCDataChannel) {
    if (ch.label === 'input') this.inputCh = ch;
    else this.stateCh = ch;
    ch.onmessage = (ev) => {
      try {
        this.events.onMessage(JSON.parse(ev.data as string) as NetMsg);
      } catch {
        /* ignore malformed frames */
      }
    };
  }

  /**
   * Attaches the camera we already opened for hand tracking. The track starts
   * disabled so video costs nothing until the player asks for it — enabling it
   * later needs no renegotiation, which is why it is added up front.
   */
  attachCamera(stream: MediaStream) {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    // A clone keeps the tracker's stream independent of what we mute here.
    const clone = track.clone();
    clone.enabled = false;
    this.videoSender = this.pc.addTrack(clone, stream);
  }

  setVideoEnabled(on: boolean) {
    const track = this.videoSender?.track;
    if (track) track.enabled = on;
  }

  get videoAvailable() {
    return !!this.videoSender;
  }

  /**
   * ICE candidates are gathered up front rather than trickled, so the whole
   * connection fits in a single pasteable code.
   */
  private async completeGathering(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(earlyTimer);
        this.pc.removeEventListener('icegatheringstatechange', check);
        this.pc.removeEventListener('icecandidate', onCandidate);
        resolve();
      };
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') done();
      };

      /*
       * Full gathering means waiting on every configured TURN URL — Cloudflare
       * publishes six — which reliably burned the whole timeout and left the
       * host staring at a spinner. One relay plus one reflexive candidate is
       * already enough to connect from anywhere, so stop shortly after both
       * arrive instead of waiting for stragglers.
       */
      let earlyTimer = 0;
      const onCandidate = () => {
        if (!this.hadRelay || !this.localCandidates.has('srflx') || earlyTimer) return;
        earlyTimer = window.setTimeout(done, ICE_SETTLE_MS);
      };

      // Emit whatever we have rather than hanging if a server is unreachable.
      const timer = setTimeout(done, ICE_TIMEOUT_MS);
      this.pc.addEventListener('icegatheringstatechange', check);
      this.pc.addEventListener('icecandidate', onCandidate);
    });
  }

  /** Host: produce the invite code. */
  async createOffer(): Promise<string> {
    this.set('connecting');
    this.bind(this.pc.createDataChannel('state', { ordered: true }));
    this.bind(
      this.pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 }),
    );
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.completeGathering();
    return encodeSignal(this.pc.localDescription!);
  }

  /** Guest: consume the invite code, produce the reply code. */
  async acceptOffer(code: string): Promise<string> {
    this.set('connecting');
    await this.pc.setRemoteDescription(await decodeSignal(code));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.completeGathering();
    return encodeSignal(this.pc.localDescription!);
  }

  /** Host: consume the reply code. */
  async acceptAnswer(code: string): Promise<void> {
    await this.pc.setRemoteDescription(await decodeSignal(code));
  }

  send(msg: NetMsg) {
    // Hand updates go unreliable; everything else must arrive.
    const ch = msg.t === 'hand' ? this.inputCh : this.stateCh;
    if (ch?.readyState === 'open') {
      try {
        ch.send(JSON.stringify(msg));
      } catch {
        /* channel closing mid-send */
      }
    }
  }

  close() {
    window.clearTimeout(this.recoverTimer);
    try {
      this.send({ t: 'bye' });
    } catch {
      /* already gone */
    }
    this.stateCh?.close();
    this.inputCh?.close();
    this.pc.close();
    this.set('closed');
  }
}
