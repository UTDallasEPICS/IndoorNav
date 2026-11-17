// Seeded random numbers (mulberry32) with a Gaussian helper, so the simulator and the particle filter are repeatable.

export interface Rng {
  /** Uniform in [0, 1) */
  uniform: () => number
  /** Standard normal */
  gaussian: () => number
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform())
  return { uniform, gaussian }
}
