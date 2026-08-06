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

/**
 * Difficulty ramps through pacing and clutter rather than speed. The early
 * levels deliberately leave long gaps between waves: the tracker adds latency
 * that a player cannot compensate for if fruit is already falling when it
 * registers.
 */
export const LEVELS: readonly LevelDef[] = [
  {
    index: 0,
    name: 'Orchard',
    brief: 'Swing your hand through the fruit. Misses are free here.',
    fruits: ['watermelon', 'strawberry'],
    quota: 10,
    spawnInterval: 2.2,
    waveMin: 1,
    waveMax: 1,
    bombChance: 0,
    tempo: 0.92,
    forgiving: true,
  },
  {
    index: 1,
    name: 'Juice Bar',
    brief: 'More fruit now. Keep the blade moving.',
    fruits: ['watermelon', 'orange', 'tomato', 'strawberry'],
    quota: 14,
    spawnInterval: 2,
    waveMin: 1,
    waveMax: 2,
    bombChance: 0,
    tempo: 0.96,
  },
  {
    index: 2,
    name: 'Grove',
    brief: 'Bombs from now on. Don’t touch them.',
    fruits: ['watermelon', 'banana', 'orange', 'coconut', 'strawberry'],
    quota: 18,
    spawnInterval: 1.85,
    waveMin: 1,
    waveMax: 2,
    bombChance: 0.14,
    tempo: 1,
  },
  {
    index: 3,
    name: 'Mixed Crate',
    brief: 'Two or three at a time. Long sweeps work best.',
    fruits: ['watermelon', 'strawberry', 'orange', 'coconut', 'banana', 'grapes'],
    quota: 22,
    spawnInterval: 1.65,
    waveMin: 2,
    waveMax: 3,
    bombChance: 0.2,
    tempo: 1.05,
  },
  {
    index: 4,
    name: 'Market Rush',
    brief: 'Faster fruit, and more bombs.',
    fruits: ['pineapple', 'grapes', 'banana', 'coconut', 'orange', 'strawberry', 'tomato'],
    quota: 26,
    spawnInterval: 1.45,
    waveMin: 2,
    waveMax: 3,
    bombChance: 0.26,
    tempo: 1.12,
  },
  {
    index: 5,
    name: 'Blender',
    brief: 'Everything at once. Good luck.',
    fruits: [
      'watermelon',
      'strawberry',
      'banana',
      'orange',
      'tomato',
      'grapes',
      'coconut',
      'pineapple',
    ],
    quota: 32,
    spawnInterval: 1.25,
    waveMin: 2,
    waveMax: 4,
    bombChance: 0.3,
    tempo: 1.2,
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
    name: `Blender +${over}`,
    brief: 'Endless. Keep your hand up.',
    quota: base.quota + over * 6,
    spawnInterval: Math.max(0.7, base.spawnInterval - over * 0.07),
    bombChance: Math.min(0.42, base.bombChance + over * 0.03),
    tempo: Math.min(1.5, base.tempo + over * 0.05),
  };
}
