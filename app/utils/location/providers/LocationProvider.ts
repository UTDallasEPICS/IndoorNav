import type { LocationEvent, LocationFix, ProviderId, ProviderStatus, VenueConfig } from '../types'

/**
 * A source of raw location fixes (BLE, GPS, later Mist or PDR). Providers don't know about each other;
 * the FusionEngine combines their fixes. Each `on*` method returns a function that removes the listener.
 */
export interface LocationProvider {
  readonly id: ProviderId
  start(venue: VenueConfig): Promise<void>
  stop(): Promise<void>
  onFix(listener: (fix: LocationFix) => void): () => void
  onStatus(listener: (status: ProviderStatus) => void): () => void
  /** Provider-specific events. Building/floor/indoor events for the app come from the FusionEngine. */
  onEvent(listener: (event: LocationEvent) => void): () => void
}
