/**
 * Picks the floor by letting the strongest beacons vote. Each of the `topN` strongest beacons votes for
 * its own floor with weight proportional to received power (mW), so one very strong beacon outweighs
 * several weak ones from the floor above or below.
 */
export function voteFloor(readings: Array<{ floorId: string, rssi: number }>, topN = 4): string | null {
  const strongest = [...readings].sort((a, b) => b.rssi - a.rssi).slice(0, topN)
  const votes = new Map<string, number>()
  for (const r of strongest) {
    votes.set(r.floorId, (votes.get(r.floorId) ?? 0) + Math.pow(10, r.rssi / 10))
  }
  let best: string | null = null
  let bestVote = 0
  for (const [floorId, vote] of votes) {
    if (vote > bestVote) {
      best = floorId
      bestVote = vote
    }
  }
  return best
}
