/** The winning floor of a vote, and how clear the win was */
export interface FloorVote {
  floorId: string
  /** The winner's share of the total vote weight, 0–1: 1 = every voting beacon is on that floor */
  share: number
}

/**
 * Picks the floor by letting the strongest beacons vote. Each of the `topN` strongest beacons votes for
 * its own floor with weight proportional to received power (mW), so one very strong beacon outweighs
 * several weak ones from the floor above or below.
 */
export function voteFloor(readings: Array<{ floorId: string, rssi: number }>, topN = 4): string | null {
  return voteFloorWithShare(readings, topN)?.floorId ?? null
}

/** `voteFloor`, also giving the winner's share of the vote. Null without readings. */
export function voteFloorWithShare(readings: Array<{ floorId: string, rssi: number }>, topN = 4): FloorVote | null {
  const strongest = [...readings].sort((a, b) => b.rssi - a.rssi).slice(0, topN)
  const votes = new Map<string, number>()
  let total = 0
  for (const r of strongest) {
    const weight = Math.pow(10, r.rssi / 10)
    votes.set(r.floorId, (votes.get(r.floorId) ?? 0) + weight)
    total += weight
  }
  let best: string | null = null
  let bestVote = 0
  for (const [floorId, vote] of votes) {
    if (vote > bestVote) {
      best = floorId
      bestVote = vote
    }
  }
  return best === null ? null : { floorId: best, share: bestVote / total }
}
