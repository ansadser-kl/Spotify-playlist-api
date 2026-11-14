import { config } from "./config.js";

const BASE_HEADERS = {
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": config.userAgent,
  referer: `${config.upstreamBase}/en1`,
  origin: config.upstreamBase,
};

/** Minimal cookie jar: enough for a PHP session, no third-party deps. */
class CookieJar {
  #cookies = new Map();

  absorb(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clear() {
    this.#cookies.clear();
  }
}

export class Session {
  constructor(index) {
    this.index = index;
    this.jar = new CookieJar();
    this.requestToken = null;
    this.tokenPromise = null;
    this.failures = 0;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
  }

  headers(extra = {}) {
    const cookie = this.jar.header();
    return { ...BASE_HEADERS, ...(cookie ? { cookie } : {}), ...extra };
  }

  async fetch(path, init = {}) {
    const res = await fetch(`${config.upstreamBase}${path}`, {
      ...init,
      headers: this.headers(init.headers),
      signal: init.signal ?? AbortSignal.timeout(config.requestTimeoutMs),
    });
    this.jar.absorb(res);
    this.lastUsedAt = Date.now();
    return res;
  }

  async ensureRequestToken(force = false) {
    if (this.requestToken && !force) return this.requestToken;
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      const res = await this.fetch("/api/get_request_token.php", { method: "GET" });
      if (!res.ok) throw new Error(`request_token_http_${res.status}`);
      const data = await res.json();
      if (!data?.success || !data.request_token) throw new Error("request_token_failed");
      this.requestToken = String(data.request_token);
      this.failures = 0;
      return this.requestToken;
    })().finally(() => {
      this.tokenPromise = null;
    });

    return this.tokenPromise;
  }

  reset() {
    this.jar.clear();
    this.requestToken = null;
    this.failures++;
  }
}

export class SessionPool {
  constructor(size) {
    this.sessions = Array.from({ length: size }, (_, i) => new Session(i));
  }

  get size() {
    return this.sessions.length;
  }

  /** Stable session per key keeps signature tokens reusable. */
  pick(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return this.sessions[(h >>> 0) % this.sessions.length];
  }

  stats() {
    return this.sessions.map((s) => ({
      index: s.index,
      hasToken: Boolean(s.requestToken),
      failures: s.failures,
      ageMs: Date.now() - s.createdAt,
    }));
  }
}
