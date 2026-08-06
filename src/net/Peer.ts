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
 *
 * Generous on purpose. Two machines on one network often pair over their local
 * addresses first, and if the router will not pass traffic between them that
 * pair dies seconds after forming. ICE then has to notice and fail over to a
 * relay pair, which takes a while, so an impatient timeout turns a recoverable
 * situation into a dead end.
 */
const RECOVER_GRACE_MS = 15000;

/** Grace after a usable candidate set arrives, to catch a few more cheaply. */
const ICE_SETTLE_MS = 500;

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
  /** Every local candidate as it is discovered, for trickling to the peer. */
  onCandidate?: (candidate: RTCIceCandidateInit) => void;
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
  private everConnected = false;
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
      if (!ev.candidate) return;
      const type = ev.candidate.type;
      if (type) {
        this.localCandidates.add(type);
        if (type === 'relay') this.hadRelay = true;
      }
      // Trickled rather than frozen into the offer. Gathering everything up
      // front meant the host's candidates were collected before the guest even
      // existed, so a NAT binding could lapse while the invite sat waiting and
      // nothing new could ever be added.
      this.events.onCandidate?.(ev.candidate.toJSON());
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;

      if (s === 'connected') {
        window.clearTimeout(this.recoverTimer);
        this.recoverTimer = 0;
        this.everConnected = true;
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
      return 'No network routes were found at all. Check that the browser is allowed network access.';
    }
    if (!this.hadRelay) {
      return `Could not find a route to the other player (tried: ${types.join(', ')}). No relay was available, so a strict network on either side will block this.`;
    }
    if (this.everConnected) {
      return 'The connection formed and then stopped passing traffic. On a shared network this usually means the router is blocking traffic between the two devices.';
    }
    return `Could not find a route to the other player (tried: ${types.join(', ')}). A relay was available, so this looks more like a firewall blocking UDP than a missing relay.`;
  }

  /** Which candidate pair actually carried traffic, for the debug overlay. */
  async route(): Promise<string> {
    try {
      const stats = await this.pc.getStats();
      let localId = '';
      let remoteId = '';
      stats.forEach((entry) => {
        const s = entry as { type?: string; state?: string; localCandidateId?: string; remoteCandidateId?: string };
        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          localId = s.localCandidateId ?? '';
          remoteId = s.remoteCandidateId ?? '';
        }
      });
      if (!localId) return this.pc.connectionState;
      const l = stats.get(localId) as { candidateType?: string } | undefined;
      const r = stats.get(remoteId) as { candidateType?: string } | undefined;
      return `${l?.candidateType ?? '?'}/${r?.candidateType ?? '?'}`;
    } catch {
      return this.pc.connectionState;
    }
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

  /** Feed in a candidate the other side trickled to us. */
  async addRemoteCandidate(init: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(init);
    } catch {
      // Candidates can arrive before the remote description, or be duplicates.
      // Neither is worth surfacing.
    }
  }

  /**
   * Asks ICE to start over with fresh candidates. Only useful now that
   * candidates are trickled, since a restart has to be able to deliver them.
   */
  async restartIce(): Promise<RTCSessionDescriptionInit | null> {
    if (this.pc.signalingState === 'closed') return null;
    this.pc.restartIce();
    return null;
  }

  /**
   * Waits briefly for the first candidates so the offer is useful on its own,
   * then stops. The rest arrive by trickle.
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

      // We only need enough to get the exchange moving; trickle delivers the
      // rest, including anything gathered after the invite is sent.
      let earlyTimer = 0;
      const onCandidate = () => {
        if (!this.localCandidates.size || earlyTimer) return;
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
