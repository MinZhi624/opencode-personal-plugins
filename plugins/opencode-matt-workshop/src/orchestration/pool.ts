export class FifoPool {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(readonly limit: number) {}
  acquire() {
    if (this.active < this.limit) { this.active += 1; return Promise.resolve() }
    return new Promise<void>((resolve) => this.waiting.push(() => { this.active += 1; resolve() }))
  }
  release() {
    if (this.active > 0) this.active -= 1
    this.waiting.shift()?.()
  }
  get running() { return this.active }
  get queued() { return this.waiting.length }
}
