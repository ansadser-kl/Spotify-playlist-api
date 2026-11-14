import { config } from "./config.js";

const BASE_HEADERS = {
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": config.userAgent,
  referer: `${config.upstreamBase}/en1`,
  origin: config.upstreamBase,
};

/**
 * Cloudflare serves its interstitial with a distinctive <title>. Normal pages
 * also load challenge-platform scripts, so don't flag those as blocked.
 */
export function isChallenge(status, body = "", headers) {
  if (headers?.get?.("cf-mitigated") === "challenge") return true;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() ?? "";
  if (/^(just a moment|attention required|access denied)/i.test(title)) return true;
  return status === 403 && /cf-chl|challenge-platform/i.test(body);
}

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
    this.bootstrapped = false;
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

  /**
   * Loads /en1 once so Cloudflare/PHP set their cookies before we hit the API.
   * Helps on IPs where the bare API call is challenged.
   */
  async bootstrap(force = false) {
    if (this.bootstrapped && !force) return true;
    const res = await this.fetch("/en1", {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    await res.text().catch(() => "");
    this.bootstrapped = res.ok;
    return res.ok;
  }

  async ensureRequestToken(force = false) {
    if (this.requestToken && !force) return this.requestToken;
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      let res = await this.fetch("/api/get_request_token.php", { method: "GET" });
      let body = await res.text();

      if (!res.ok) {
        // No cookies yet (or a fresh IP): load the page once and retry.
        await this.bootstrap().catch(() => {});
        res = await this.fetch("/api/get_request_token.php", { method: "GET" });
        body = await res.text();
      }

      if (!res.ok) {
        const challenge = isChallenge(res.status, body, res.headers);
        const err = new Error(
          `request_token_http_${res.status}${challenge ? " (cloudflare challenge)" : ""}`
        );
        err.status = res.status;
        err.upstreamBody = body.slice(0, 300);
        throw err;
      }

      let data = null;
      try {
        data = JSON.parse(body);
      } catch {
        data = null;
      }
      if (!data?.success || !data.request_token) throw new Error("request_token_failed");

      this.requestToken = String(data.request_token);
      this.failures = 0;
      return this.requestToken;
    })().finally(() => {
      this.tokenPromise = null;
    });

    return this.tokenPromise;
  }

  /** Diagnostics: is the page reachable from this host, and does the token API work? */
  async probe() {
    const started = performance.now();
    const page = await this.fetch("/en1", {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const pageBody = await page.text();

    const tokenRes = await this.fetch("/api/get_request_token.php");
    const tokenBody = await tokenRes.text();

    return {
      page: {
        status: page.status,
        bytes: pageBody.length,
        cf_ray: page.headers.get("cf-ray") ?? null,
        challenged: isChallenge(page.status, pageBody, page.headers),
        cf_mitigated: page.headers.get("cf-mitigated") ?? null,
      },
      token: {
        status: tokenRes.status,
        cf_ray: tokenRes.headers.get("cf-ray") ?? null,
        ok: /"success"\s*:\s*true/.test(tokenBody),
        challenged: isChallenge(tokenRes.status, tokenBody, tokenRes.headers),
        head: tokenBody.slice(0, 90).replace(/[0-9a-f]{40,}/gi, "<redacted>"),
      },
      elapsed_ms: Math.round(performance.now() - started),
    };
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
