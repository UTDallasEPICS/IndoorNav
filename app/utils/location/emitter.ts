/** Minimal typed event emitter used by providers, fusion, and the service. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>()

  /** Adds a listener and returns a function that removes it. */
  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.off(listener)
  }

  off(listener: (value: T) => void) {
    this.listeners.delete(listener)
  }

  emit(value: T) {
    for (const listener of [...this.listeners]) listener(value)
  }

  clear() {
    this.listeners.clear()
  }
}
