/**
 * Small seeded PRNG (mulberry32). Both players run this with the same seed so
 * their boards produce an identical fruit sequence — that is what makes a
 * versus race fair without any of the fruit itself crossing the network.
 *
 * Only spawn decisions draw from here. Cosmetic randomness (particles, spin)
 * deliberately keeps using Math.random(), so the two streams can never
 * interfere with each other.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Any 32-bit state works; force it into range so string seeds behave.
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Fresh stream for a given level, so a mid-match rejoin can resynchronise. */
  static forLevel(matchSeed: number, levelIndex: number): Rng {
    return new Rng((Math.imul(matchSeed, 0x9e3779b1) + levelIndex * 0x85ebca6b) >>> 0);
  }
}

/** Short, human-shareable seed. */
export const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;
