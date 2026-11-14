import { config, DEFAULTS } from "./config.js";
import { Semaphore, TTLCache, singleFlight } from "./cache.js";
import { Session, SessionPool } from "./session.js";

export class UpstreamError extends Error {
  constructor(message, { status = 502, code = "upstream_error", retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const b64url = (str) => Buffer.from(str, "utf8").toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Upstream {
  constructor({ poolSize = config.sessionPoolSize } = {}) {
    this.pool = new SessionPool(poolSize);
    this.signatures = new TTLCache({ max: 1000, ttlMs: 90_000 });
    this.downloadLinks = new TTLCache({ max: 2000, ttlMs: 5 * 60_000 });
    this.dlSem = new Semaphore(config.downloadConcurrency);
    this.tasks = new TTLCache({ max: 500, ttlMs: 2 * 3600_000 });
    this.wire = DEFAULTS.wire;
    this.wireLoadedAt = 0;
    this.sem = new Semaphore(config.maxConcurrent);
  }

  // ------------------------------------------------------------- wire config

  async refreshWire(force = false) {
    if (!force && this.wireLoadedAt && Date.now() - this.wireLoadedAt < 6 * 3600_000) {
      return this.wire;
    }
    try {
      const session = this.pool.sessions[0];
      const res = await session.fetch("/en1");
      const html = await res.text();
      const marker = "playlistRequestSignature = ";
      const at = html.indexOf(marker);
      if (at === -1) throw new Error("wire marker not found");
      const objStart = html.indexOf("{", at);
      const raw = extractJsonObject(html, objStart);
      const parsed = JSON.parse(raw);
      if (parsed?.wire?.token_param && parsed?.wire?.actions) {
        this.wire = { ...DEFAULTS.wire, ...parsed.wire, actions: { ...DEFAULTS.wire.actions, ...parsed.wire.actions } };
        this.wireLoadedAt = Date.now();
      }
    } catch (err) {
      // Keep the last known-good (or built-in) wire names.
      this.wireLoadedAt = this.wireLoadedAt || Date.now();
    }
    return this.wire;
  }

  // -------------------------------------------------------------- signatures

  async signature(session, cacheKey, id, type, lang, force = false) {
    return this.sign(session, cacheKey, "get_playlist", { id, type, lang }, force);
  }

  async sign(session, cacheKey, actionName, context, force = false) {
    if (!force) {
      const hit = this.signatures.get(cacheKey);
      if (hit && hit.sessionIndex === session.index) return hit;
    }

    const token = await session.ensureRequestToken(force);
    const action = this.wire.actions[actionName] ?? actionName;
    const ctx = b64url(JSON.stringify(context));
    const params = new URLSearchParams({
      [this.wire.token_param]: token,
      [this.wire.action_param]: action,
      [this.wire.ctx_param]: ctx,
    });

    const res = await session.fetch(`/api/get_signature.php?${params}`, { method: "GET" });
    const data = await res.json().catch(() => null);

    if (!res.ok || !data?.success || !data.token) {
      throw new UpstreamError(
        `signature failed: ${data?.error ?? res.status}`,
        { status: 502, code: "signature_failed", retryable: true }
      );
    }

    const expMs = Number(data.exp) * 1000;
    const ttl = Math.max(15_000, expMs - Date.now() - config.signatureTtlSkewMs);
    const sig = { token: String(data.token), exp: String(data.exp), sessionIndex: session.index };
    this.signatures.set(cacheKey, sig, ttl);
    return sig;
  }

  // --------------------------------------------------------------- playlist

  async playlist(id, { type = "playlist", lang = config.defaultLang } = {}) {
    const cacheKey = `${type}:${id}:${lang}`;
    const entry = this.cache?.peek(cacheKey);

    if (entry && !entry.expired) {
      return { data: entry.value, cache: "HIT", elapsedMs: 0 };
    }
    if (entry) {
      // Stale-while-revalidate: answer instantly, refresh in the background.
      this.refresh(cacheKey, id, type, lang).catch(() => {});
      return { data: entry.value, cache: "STALE", elapsedMs: 0 };
    }
    return this.refresh(cacheKey, id, type, lang);
  }

  refresh(cacheKey, id, type, lang) {
    return singleFlight(cacheKey, async () => {
      const again = this.cache?.get(cacheKey);
      if (again) return { data: again, cache: "HIT", elapsedMs: 0 };

      const started = performance.now();
      let lastError;
      const attempts = config.maxRetries + 1;
      const release = await this.sem.acquire();

      try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const session = this.pool.pick(attempt === 0 ? cacheKey : `${cacheKey}:retry${attempt}`);
        try {
          const sig = await this.signature(session, cacheKey, id, type, lang, attempt > 0);
          const qs = new URLSearchParams({ id, type, lang });
          const res = await session.fetch(`/api/get_playlist.php?${qs}`, {
            method: "GET",
            headers: { [this.wire.sig_header]: sig.token, [this.wire.exp_header]: sig.exp },
          });
          const text = await res.text();

          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw new UpstreamError("upstream returned non-JSON", { code: "bad_payload", retryable: true });
          }

          if (!res.ok || !data?.playlist_info) {
            const message = data?.error ?? `HTTP ${res.status}`;
            const retryable = res.status === 403 || res.status === 429 || /verification|refresh/i.test(message);
            throw new UpstreamError(message, {
              status: res.status === 429 ? 429 : 502,
              code: res.status === 403 ? "verification_failed" : "playlist_failed",
              retryable,
            });
          }

          if (this.cache) this.cache.set(cacheKey, data);
          return { data, cache: "MISS", elapsedMs: Math.round(performance.now() - started) };
        } catch (err) {
          lastError = err;
          session.reset();
          if (err.code === "signature_failed" && attempt === 0) {
            await this.refreshWire(true).catch(() => {});
          }
          const retryable = err instanceof UpstreamError ? err.retryable : true;
          if (!retryable || attempt === attempts - 1) break;
          await sleep(150 * 2 ** attempt + Math.random() * 100);
        }
      }
      } finally {
        release();
      }

      if (lastError instanceof UpstreamError) throw lastError;
      throw new UpstreamError(String(lastError?.message ?? lastError));
    });
  }

  async batch(ids, opts = {}) {
    const queue = [...new Set(ids)].slice(0, config.batchMaxIds);
    const results = new Array(queue.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const i = cursor++;
        const id = queue[i];
        try {
          const { data } = await this.playlist(id, opts);
          results[i] = { id, ok: true, data };
        } catch (err) {
          results[i] = { id, ok: false, error: { code: err.code ?? "error", message: err.message } };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(config.batchConcurrency, queue.length) }, worker)
    );
    return results;
  }

  // ------------------------------------------------------------- downloads

  async downloadTrack(track, { lang = config.defaultLang } = {}) {
    const cacheKey = `dl:track:${track.id}:${lang}`;
    const cached = this.downloadLinks.get(cacheKey);
    if (cached) return { ...cached, cache: "HIT" };

    return singleFlight(cacheKey, async () => {
      const release = await this.dlSem.acquire();
      try {
        let lastError;
        for (let attempt = 0; attempt <= config.downloadRetries; attempt++) {
          const session = this.pool.pick(`dl:${track.id}`);
          try {
            const sig = await this.sign(
              session,
              `sig:dl:${track.id}`,
              "download_track",
              { lang, id: track.id, name: track.name, duration_ms: String(track.duration_ms) },
              attempt > 0
            );
            const body = {
              track,
              download_dir: "downloads",
              filename_tag: "SPOTISAVER",
              is_premium: false,
              lang,
              direct: true,
            };
            if (config.userIp) body.user_ip = config.userIp;

            const res = await session.fetch("/api/download_track.php", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                [this.wire.sig_header]: sig.token,
                [this.wire.exp_header]: sig.exp,
              },
              body: JSON.stringify(body),
            });

            const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
            if (!contentType.includes("json")) {
              throw new UpstreamError("unexpected binary response", {
                code: "bad_download_response",
                retryable: true,
              });
            }

            const data = await res.json();
            if (data?.download_url) {
              const result = {
                download_url: data.download_url,
                filename: data.filename ?? `${track.name}.mp3`,
                expires_at: data.relay?.exp ?? null,
                relay: data.relay ?? null,
              };
              const ttl = data.relay?.exp
                ? Math.max(30_000, data.relay.exp * 1000 - Date.now() - 30_000)
                : undefined;
              this.downloadLinks.set(cacheKey, result, ttl);
              return { ...result, cache: "MISS" };
            }

            lastError = new UpstreamError(data?.error ?? `download failed (${res.status})`, {
              status: res.status === 429 ? 429 : 502,
              code: data?.error === "No available slots" ? "no_slots" : "download_failed",
              retryable: true,
            });
          } catch (err) {
            lastError = err;
            session.reset();
          }
          if (attempt < config.downloadRetries) await sleep(config.downloadRetryDelayMs);
        }
        throw lastError ?? new UpstreamError("download failed");
      } finally {
        release();
      }
    });
  }

  async startPlaylistDownload(playlistInfo, tracks, { lang = config.defaultLang } = {}) {
    const session = this.pool.pick(`dlpl:${playlistInfo.id}`);
    const sig = await this.sign(
      session,
      `sig:dlpl:${playlistInfo.id}`,
      "download_playlist",
      { url: String(playlistInfo.external_url ?? ""), count: String(tracks.length), lang }
    );

    const body = {
      playlist_url: playlistInfo.external_url,
      tracks,
      playlist_info: playlistInfo,
      is_premium: false,
      playlist_name: playlistInfo.name,
      lang,
    };
    if (config.userIp) body.user_ip = config.userIp;

    const res = await session.fetch("/api/download_playlist.php", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [this.wire.sig_header]: sig.token,
        [this.wire.exp_header]: sig.exp,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (!data?.task_id) {
      throw new UpstreamError(data?.error ?? `playlist download failed (${res.status})`, {
        status: res.status === 429 ? 429 : 502,
        code: data?.error === "No available slots" ? "no_slots" : "playlist_download_failed",
        retryable: true,
      });
    }

    this.tasks.set(String(data.task_id), {
      playlist_url: playlistInfo.external_url,
      lang,
    });
    return { task_id: String(data.task_id), ...data };
  }

  async downloadStatus(taskId) {
    const session = this.pool.sessions[0];
    const res = await session.fetch(
      `/api/get_download_status.php?task_id=${encodeURIComponent(taskId)}`
    );
    const data = await res.json().catch(() => ({}));
    return { http_status: res.status, ...data };
  }

  async createZip(taskId) {
    const meta = this.tasks.get(String(taskId));
    if (!meta) throw new UpstreamError("unknown task_id", { status: 404, code: "unknown_task" });

    const session = this.pool.sessions[0];
    const res = await session.fetch("/api/create_zip.php", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playlist_url: meta.playlist_url,
        task_id: String(taskId),
        lang: meta.lang,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new UpstreamError(data?.error ?? `zip creation failed (${res.status})`, {
        code: "zip_failed",
        retryable: true,
      });
    }
    return data;
  }

  setCache(cache) {
    this.cache = cache;
    return this;
  }

  /** Fetch a request token for every pooled session so first real hits are fast. */
  async prewarm() {
    const results = await Promise.allSettled(
      this.pool.sessions.map((s) => s.ensureRequestToken())
    );
    return results.filter((r) => r.status === "fulfilled").length;
  }

  /** Deep health check: can this host reach the upstream at all? */
  async diagnose() {
    const session = new Session(999);
    const [probe, ip] = await Promise.all([
      session.probe().catch((err) => ({ error: err.message })),
      fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json())
        .then((j) => j.ip)
        .catch(() => null),
    ]);
    return {
      upstream_base: config.upstreamBase,
      proxy_enabled: Boolean(config.proxyUrl),
      egress_ip: ip,
      ...probe,
    };
  }

  stats() {
    return { pool: this.pool.stats(), wire: this.wire, wireLoadedAt: this.wireLoadedAt };
  }
}

/** Extracts a top-level JSON object starting at `start`, string-aware. */
export function extractJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("unterminated JSON object");
}
