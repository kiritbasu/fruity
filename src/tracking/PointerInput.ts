import type { InputSource, Pose, ScreenHand, TrackerStats } from './types';

/**
 * Mouse/trackpad fallback that presents itself to the game as a single hand.
 * It exists for machines with no camera (and for debugging the game loop
 * without one), so the pose mapping mirrors the real gestures:
 *
 *   no button  → open hand  → slice
 *   left held  → pinch      → squish
 *   right held → fist       → punch
 */
export class PointerInput implements InputSource {
  private x = 0;
  private y = 0;
  private prevX = 0;
  private prevY = 0;
  private lastX = 0;
  private lastY = 0;
  private lastMove = 0;
  private vx = 0;
  private vy = 0;
  private left = false;
  private right = false;
  private wasPinching = false;
  private present = false;
  /** Held between moves so a parked cursor keeps its last sword angle. */
  private dirX = 0.7;
  private dirY = -0.7;

  constructor(private target: HTMLElement = document.body) {
    target.addEventListener('pointermove', this.onMove);
    target.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    target.addEventListener('contextmenu', this.onContext);
    target.addEventListener('pointerleave', this.onLeave);
  }

  private onMove = (e: PointerEvent) => {
    const now = performance.now();
    const dt = Math.max(1e-3, (now - this.lastMove) / 1000);
    // Only trust velocity from closely spaced events; a long gap means the
    // pointer was parked, not that it teleported.
    if (this.present && dt < 0.12) {
      this.vx = (e.clientX - this.lastX) / dt;
      this.vy = (e.clientY - this.lastY) / dt;
    } else {
      this.vx = 0;
      this.vy = 0;
    }
    const mag = Math.hypot(this.vx, this.vy);
    if (mag > 60) {
      this.dirX += (this.vx / mag - this.dirX) * 0.3;
      this.dirY += (this.vy / mag - this.dirY) * 0.3;
      const m = Math.hypot(this.dirX, this.dirY) || 1;
      this.dirX /= m;
      this.dirY /= m;
    }

    this.lastMove = now;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.x = e.clientX;
    this.y = e.clientY;
    this.present = true;
  };

  private onDown = (e: PointerEvent) => {
    if (e.button === 0) this.left = true;
    if (e.button === 2) this.right = true;
  };

  private onUp = (e: PointerEvent) => {
    if (e.button === 0) this.left = false;
    if (e.button === 2) this.right = false;
  };

  private onContext = (e: Event) => e.preventDefault();
  private onLeave = () => {
    this.present = false;
  };

  private get pose(): Pose {
    if (this.left) return 'pinch';
    if (this.right) return 'fist';
    return 'open';
  }

  getHands(nowMs: number, _width: number, height: number): ScreenHand[] {
    void _width;
    if (!this.present) return [];

    // Velocity decays if the pointer stopped moving, so a parked cursor stops
    // reading as an active swipe.
    if (nowMs - this.lastMove > 90) {
      this.vx *= 0.6;
      this.vy *= 0.6;
    }

    const pose = this.pose;
    const pinching = pose === 'pinch';
    const pinchStarted = pinching && !this.wasPinching;
    this.wasPinching = pinching;

    const radius = height * 0.075;
    const hand: ScreenHand = {
      id: 'pointer',
      x: this.x,
      y: this.y,
      prevX: this.prevX,
      prevY: this.prevY,
      vx: this.vx,
      vy: this.vy,
      speed: Math.hypot(this.vx, this.vy),
      pose,
      pinchStarted,
      pinchStrength: pinching ? 1 : 0,
      radius,
      dirX: this.dirX,
      dirY: this.dirY,
      handedness: 'Right',
      thumbTip: { x: this.x - radius * 0.3, y: this.y + radius * 0.3 },
      indexTip: { x: this.x + radius * 0.3, y: this.y - radius * 0.3 },
    };

    this.prevX = this.x;
    this.prevY = this.y;
    return [hand];
  }

  get stats(): TrackerStats {
    return {
      inferenceMs: 0,
      trackerHz: 0,
      targetHz: 0,
      cameraHz: 0,
      delegate: '—',
      mode: 'pointer',
      handsVisible: this.present ? 1 : 0,
    };
  }

  stop() {
    this.target.removeEventListener('pointermove', this.onMove);
    this.target.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    this.target.removeEventListener('contextmenu', this.onContext);
    this.target.removeEventListener('pointerleave', this.onLeave);
  }
}
