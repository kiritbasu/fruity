import type { FruitId } from './fruitDefs';

export interface LevelDef {
  index: number;
  name: string;
  /** Shown on the level card before play. */
  brief: string;
  fruits: readonly FruitId[];
  /** Fruits to destroy to clear the level. */
  quota: number;
  /** Seconds between spawn waves. */
  spawnInterval: number;
  /** Fruits per wave. */
  waveMin: number;
  waveMax: number;
  /** Chance a wave also includes a bomb. */
  bombChance: number;
  /**
   * Scales gravity. Above 1 the arc is faster and the hang time shorter, so
   * this is the main difficulty dial — keep the ramp gentle.
   */
  tempo: number;
  /** Practice round: missed fruit costs nothing. */
  forgiving?: boolean;
}

/** Every fruit in the game, which most of the later levels draw from. */
const EVERYTHING: readonly FruitId[] = [
  'watermelon',
  'strawberry',
  'banana',
  'orange',
  'tomato',
  'grapes',
  'coconut',
  'pineapple',
];

/**
 * Ten levels, ramping through pacing and clutter rather than raw speed.
 *
 * Every wave carries several fruit, even in the opening level. Two players
 * share one board, so a wave of one means whoever swings first takes it and the
 * other has nothing to do; solo, a near-empty screen just reads as waiting.
 * Difficulty comes from `tempo` instead, which shortens hang time — that is
 * what actually decides whether a player can reach the fruit in time.
 */
export const LEVELS: readonly LevelDef[] = [
  {
    index: 0,
    name: 'Orchard',
    brief: 'Swing your hand through the fruit. Misses are free here.',
    fruits: ['watermelon', 'strawberry', 'orange'],
    quota: 12,
    spawnInterval: 1.7,
    waveMin: 2,
    waveMax: 3,
    bombChance: 0,
    tempo: 0.9,
    forgiving: true,
  },
  {
    index: 1,
    name: 'Juice Bar',
    brief: 'More fruit, and misses count now.',
    fruits: ['watermelon', 'orange', 'tomato', 'strawberry'],
    quota: 16,
    spawnInterval: 1.6,
    waveMin: 3,
    waveMax: 4,
    bombChance: 0,
    tempo: 0.94,
  },
  {
    index: 2,
    name: 'Grove',
    brief: 'Bombs from now on. Don’t touch them.',
    fruits: ['watermelon', 'banana', 'orange', 'coconut', 'strawberry'],
    quota: 20,
    spawnInterval: 1.5,
    waveMin: 3,
    waveMax: 4,
    bombChance: 0.12,
    tempo: 0.98,
  },
  {
    index: 3,
    name: 'Mixed Crate',
    brief: 'Long sweeps take out more than one at a time.',
    fruits: ['watermelon', 'strawberry', 'orange', 'coconut', 'banana', 'grapes'],
    quota: 24,
    spawnInterval: 1.4,
    waveMin: 3,
    waveMax: 5,
    bombChance: 0.16,
    tempo: 1.02,
  },
  {
    index: 4,
    name: 'Market Rush',
    brief: 'Busier, and more bombs mixed in.',
    fruits: ['pineapple', 'grapes', 'banana', 'coconut', 'orange', 'strawberry', 'tomato'],
    quota: 28,
    spawnInterval: 1.3,
    waveMin: 4,
    waveMax: 5,
    bombChance: 0.2,
    tempo: 1.06,
  },
  {
    index: 5,
    name: 'Smoothie Stand',
    brief: 'Everything on the menu at once.',
    fruits: EVERYTHING,
    quota: 32,
    spawnInterval: 1.24,
    waveMin: 4,
    waveMax: 6,
    bombChance: 0.24,
    tempo: 1.1,
  },
  {
    index: 6,
    name: 'Fruit Cart',
    brief: 'Keep the blade moving and don’t stop to aim.',
    fruits: EVERYTHING,
    quota: 36,
    spawnInterval: 1.15,
    waveMin: 4,
    waveMax: 6,
    bombChance: 0.27,
    tempo: 1.14,
  },
  {
    index: 7,
    name: 'Harvest',
    brief: 'Full screen. Pick your line and follow through.',
    fruits: EVERYTHING,
    quota: 40,
    spawnInterval: 1.08,
    waveMin: 5,
    waveMax: 7,
    bombChance: 0.3,
    tempo: 1.18,
  },
  {
    index: 8,
    name: 'Blender',
    brief: 'Fast, loud and full of bombs.',
    fruits: EVERYTHING,
    quota: 46,
    spawnInterval: 1,
    waveMin: 5,
    waveMax: 7,
    bombChance: 0.33,
    tempo: 1.24,
  },
  {
    index: 9,
    name: 'Last Call',
    brief: 'The whole orchard at once. Good luck.',
    fruits: EVERYTHING,
    quota: 52,
    spawnInterval: 0.94,
    waveMin: 6,
    waveMax: 8,
    bombChance: 0.36,
    tempo: 1.3,
  },
];

/**
 * Past the authored levels, keep generating harder variants so a good run
 * doesn't hit a wall.
 */
export function levelAt(index: number): LevelDef {
  if (index < LEVELS.length) return LEVELS[index];
  const base = LEVELS[LEVELS.length - 1];
  const over = index - LEVELS.length + 1;
  return {
    ...base,
    index,
    name: `Last Call +${over}`,
    brief: 'Endless. Keep your hand up.',
    quota: base.quota + over * 6,
    spawnInterval: Math.max(0.68, base.spawnInterval - over * 0.05),
    bombChance: Math.min(0.44, base.bombChance + over * 0.02),
    tempo: Math.min(1.5, base.tempo + over * 0.04),
  };
}
