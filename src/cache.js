export class TTLCache {
  constructor({ max = 2000, ttlMs = 600_000, staleTtlMs = 0 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.staleTtlMs = staleTtlMs;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) {
      this.misses++;
      return undefined;
    }
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits++;
    return hit.value;
  }

  /** Returns { value, expired } while inside the stale window, else undefined. */
  peek(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    const now = Date.now();
    if (now > hit.expiresAt + this.staleTtlMs) {
      this.map.delete(key);
      return undefined;
    }
    return { value: hit.value, expired: hit.expiresAt <= now };
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  delete(key) {
    this.map.delete(key);
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      max: this.max,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? +(this.hits / total).toFixed(3) : 0,
    };
  }
}

export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
    } else {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}

const inflight = new Map();

/** Collapses identical concurrent work into one upstream call. */
export function singleFlight(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
