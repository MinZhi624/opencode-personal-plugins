export class FifoPool {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
    }
    acquire() {
        if (this.active < this.limit) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => this.waiting.push(() => { this.active += 1; resolve(); }));
    }
    release() {
        if (this.active > 0)
            this.active -= 1;
        this.waiting.shift()?.();
    }
    get running() { return this.active; }
    get queued() { return this.waiting.length; }
}
