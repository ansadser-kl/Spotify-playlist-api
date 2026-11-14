import Fastify from "fastify";
import compress from "@fastify/compress";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { config } from "./config.js";
import { TTLCache } from "./cache.js";
import { Upstream, UpstreamError } from "./upstream.js";
import { detectSpotifyType, extractSpotifyId, normalizePlaylist } from "./normalize.js";

const TYPES = new Set(["playlist", "album", "track"]);

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  const cache = new TTLCache({
    max: config.cacheMax,
    ttlMs: config.cacheTtlMs,
    staleTtlMs: config.cacheStaleMs,
  });
  const upstream = new Upstream().setCache(cache);
  await upstream.refreshWire();

  await app.register(cors, { origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") });
  await app.register(compress, { global: true, threshold: 1024 });
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    allowList: (req) => !config.apiKeys.length && req.url === "/health",
  });

  // ---------------------------------------------------------------- helpers

  const parseId = (input, type) => {
    const id = extractSpotifyId(input, type);
    if (!id) {
      const err = new Error("Invalid id. Pass a Spotify URL, URI or bare id.");
      err.statusCode = 400;
      err.code = "invalid_id";
      throw err;
    }
    return id;
  };

  const parseOpts = (query = {}) => ({
    type: TYPES.has(query.type) ? query.type : "playlist",
    lang: typeof query.lang === "string" && query.lang ? query.lang : config.defaultLang,
  });

  const wantFlag = (value) => value === "1" || value === "true";

  const baseUrl = (request) => {
    const host = request.headers.host ?? `localhost:${config.port}`;
    return `${request.protocol}://${host}`;
  };

  const trackDownloadUrl = (base, track, direct = false) => {
    const target = track.external_url ?? `https://open.spotify.com/track/${track.id}`;
    return `${base}/api/download?url=${encodeURIComponent(target)}${direct ? "&redirect=1" : ""}`;
  };

  const servePlaylist = async (request, reply, input, { autoType = false } = {}) => {
    const detected = autoType ? detectSpotifyType(input) : null;
    const type = TYPES.has(request.query.type)
      ? request.query.type
      : detected ?? "playlist";
    const lang = typeof request.query.lang === "string" && request.query.lang
      ? request.query.lang
      : config.defaultLang;
    const id = parseId(input, type);
    if (wantFlag(request.query.refresh)) {
      cache.delete(`${type}:${id}:${lang}`);
    }
    const { data, cache: hit, elapsedMs } = await upstream.playlist(id, { type, lang });
    const normalized = normalizePlaylist(data);
    const base = baseUrl(request);

    const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 500);
    const offset = Math.max(Number(request.query.offset ?? 0), 0);
    const withLinks = normalized.tracks.map((track) => ({
      ...track,
      download_url: trackDownloadUrl(base, track, true),
      download_info_url: trackDownloadUrl(base, track),
    }));
    const tracks = withLinks.slice(offset, offset + limit);

    const playlistTarget =
      normalized.external_url ??
      (type === "album"
        ? `https://open.spotify.com/album/${normalized.id}`
        : `https://open.spotify.com/playlist/${normalized.id}`);

    const download = {
      // Playlist/album -> zip of all tracks (async; add &wait=1 to block).
      zip_url: `${base}/api/download/playlist?url=${encodeURIComponent(playlistTarget)}`,
      zip_wait_url: `${base}/api/download/playlist?url=${encodeURIComponent(playlistTarget)}&wait=1`,
    };
    if (type === "track" && normalized.tracks.length === 1) {
      download.track_url = trackDownloadUrl(base, normalized.tracks[0], true);
      download.track_info_url = trackDownloadUrl(base, normalized.tracks[0]);
    }

    // ?download=1 resolves a real upstream MP3 link (slow, single track only).
    if (wantFlag(request.query.download) && type === "track" && data.tracks?.[0]) {
      const started = performance.now();
      const result = await upstream.downloadTrack(data.tracks[0], { lang });
      download.track_url = result.download_url;
      download.track_filename = result.filename;
      download.track_expires_at = result.expires_at;
      download.track_resolve_ms = Math.round(performance.now() - started);
    }

    reply.header("x-cache", hit);
    reply.header("cache-control", `public, max-age=${Math.round(config.cacheTtlMs / 1000)}`);
    reply.header("server-timing", `upstream;dur=${elapsedMs}`);

    if (wantFlag(request.query.raw)) {
      return { data: normalized, download, meta: { cache: hit, elapsed_ms: elapsedMs } };
    }

    return {
      ...normalized,
      tracks,
      track_count: normalized.tracks.length,
      offset,
      limit,
      download,
      meta: { cache: hit, elapsed_ms: elapsedMs },
    };
  };

  // ---------------------------------------------------------------- routes

  app.get("/", async () => ({
    name: "SpotifyDL API",
    version: "0.2.0",
    endpoints: [
      "GET /health",
      "GET /api/diagnose",
      "GET /api/playlist?url=<spotify url>",
      "GET /api/download?url=<track url>[&redirect=1]",
      "GET /api/download/playlist?url=<playlist url>[&wait=1]",
      "GET /api/download/status?task_id=",
      "GET /api/download/zip?task_id=",
      "GET /v1/playlist/:id?lang=en&limit=100&offset=0",
      "GET /v1/playlist/:id/search?q=query",
      "GET /v1/resolve?url=<spotify-url>",
      "POST /v1/playlists { ids: [] }",
    ],
  }));

  app.get("/health", async () => ({
    status: "ok",
    uptime_s: Math.round(process.uptime()),
    cache: cache.stats(),
    ...upstream.stats(),
  }));

  // Tells you whether this host can actually reach the upstream (IP blocks etc).
  app.get("/api/diagnose", async () => upstream.diagnose());

  // Internal relay for hosts whose egress IP is blocked by upstream Cloudflare.
  // Render instances point their upstream calls here (residential tunnel).
  app.all("/relay/*", async (request, reply) => {
    if (config.relayKey && request.headers["x-relay-key"] !== config.relayKey) {
      return reply.status(401).send({ code: "unauthorized", message: "invalid relay key" });
    }

    const upstreamPath = request.raw.url.slice("/relay".length);
    const target = `${config.upstreamBase}${upstreamPath}`;
    const skip = new Set([
      "host", "connection", "content-length", "accept-encoding", "x-relay-key",
      "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
      "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
    ]);
    const headers = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (!skip.has(k)) headers[k] = v;
    }

    let body;
    if (!["GET", "HEAD"].includes(request.method)) {
      body =
        typeof request.body === "string" || Buffer.isBuffer(request.body)
          ? request.body
          : request.body === undefined
            ? undefined
            : JSON.stringify(request.body);
    }

    const res = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    const outHeaders = {};
    for (const [k, v] of res.headers) {
      if (["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(k)) continue;
      outHeaders[k] = v;
    }
    const cookies = res.headers.getSetCookie?.();
    if (cookies?.length) outHeaders["set-cookie"] = cookies;
    for (const [k, v] of Object.entries(outHeaders)) reply.header(k, v);

    const buf = Buffer.from(await res.arrayBuffer());
    return reply.status(res.status).send(buf);
  });

  app.get("/v1/playlist/:id", async (request, reply) =>
    servePlaylist(request, reply, request.params.id)
  );

  // Convenience endpoint: /api/playlist?url=<spotify playlist/album/track url>
  app.get("/api/playlist", async (request, reply) => {
    const input = request.query.url ?? request.query.id;
    if (!input) {
      const err = new Error("url query parameter is required");
      err.statusCode = 400;
      err.code = "missing_url";
      throw err;
    }
    return servePlaylist(request, reply, input, { autoType: true });
  });

  app.get("/v1/resolve", async (request, reply) => {
    if (!request.query.url) {
      const err = new Error("url query parameter is required");
      err.statusCode = 400;
      err.code = "missing_url";
      throw err;
    }
    return servePlaylist(request, reply, request.query.url, { autoType: true });
  });

  app.get("/v1/playlist/:id/search", async (request) => {
    const q = String(request.query.q ?? "").trim().toLowerCase();
    if (!q) {
      const err = new Error("q query parameter is required");
      err.statusCode = 400;
      err.code = "missing_query";
      throw err;
    }
    const { type, lang } = parseOpts(request.query);
    const id = parseId(request.params.id, type);
    const { data, cache: hit } = await upstream.playlist(id, { type, lang });
    const normalized = normalizePlaylist(data);
    const tracks = normalized.tracks.filter(
      (t) =>
        t.name?.toLowerCase().includes(q) ||
        t.album?.toLowerCase().includes(q) ||
        t.artists.some((a) => a.toLowerCase().includes(q))
    );
    return { id, query: q, total: tracks.length, tracks, meta: { cache: hit } };
  });

  app.post("/v1/playlists", async (request) => {
    const body = request.body ?? {};
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      const err = new Error("body.ids must be a non-empty array");
      err.statusCode = 400;
      err.code = "invalid_body";
      throw err;
    }
    const { type, lang } = parseOpts(body);
    const ids = body.ids.map((v) => parseId(v, type));
    const started = performance.now();
    const results = await upstream.batch(ids, { type, lang });
    return {
      count: results.length,
      elapsed_ms: Math.round(performance.now() - started),
      results: results.map((r) =>
        r.ok
          ? { id: r.id, ok: true, ...normalizePlaylist(r.data) }
          : { id: r.id, ok: false, error: r.error }
      ),
    };
  });

  // Single track: returns the direct MP3 link. Add &redirect=1 to 302 straight
  // to the file so the URL itself is a usable download link.
  app.get("/api/download", async (request, reply) => {
    const input = request.query.url ?? request.query.id;
    if (!input) {
      const err = new Error("url query parameter is required");
      err.statusCode = 400;
      err.code = "missing_url";
      throw err;
    }
    const type = detectSpotifyType(input) ?? "track";
    const lang = typeof request.query.lang === "string" && request.query.lang
      ? request.query.lang
      : config.defaultLang;
    const id = parseId(input, type == "track" ? "track" : type);
    const { data } = await upstream.playlist(id, { type, lang });
    const rawTrack = data.tracks?.[0];
    if (!rawTrack) {
      const err = new Error("track not found for this url");
      err.statusCode = 404;
      err.code = "track_not_found";
      throw err;
    }

    const started = performance.now();
    const result = await upstream.downloadTrack(rawTrack, { lang });
    const elapsedMs = Math.round(performance.now() - started);

    if (wantFlag(request.query.redirect)) {
      return reply.redirect(result.download_url, 302);
    }

    reply.header("x-cache", result.cache);
    reply.header("server-timing", `upstream;dur=${elapsedMs}`);
    return {
      id: rawTrack.id,
      name: rawTrack.name,
      artists: rawTrack.artists ?? [],
      duration_ms: rawTrack.duration_ms ?? null,
      download_url: result.download_url,
      filename: result.filename,
      expires_at: result.expires_at,
      relay: result.relay,
      meta: { cache: result.cache, elapsed_ms: elapsedMs },
    };
  });

  // Playlist/album zip: starts an upstream task, optionally polls until done and
  // creates the archive. `&wait=1` blocks up to DOWNLOAD_WAIT_MS.
  app.get("/api/download/playlist", async (request, reply) => {
    const input = request.query.url ?? request.query.id;
    if (!input) {
      const err = new Error("url query parameter is required");
      err.statusCode = 400;
      err.code = "missing_url";
      throw err;
    }
    const type = detectSpotifyType(input) ?? "playlist";
    const lang = typeof request.query.lang === "string" && request.query.lang
      ? request.query.lang
      : config.defaultLang;
    const id = parseId(input, type);
    const { data, cache: hit } = await upstream.playlist(id, { type, lang });

    // Slots are shared globally upstream; retry the rejected request until the
    // advertised retry_after elapses. `wait=1` may use the full budget.
    const startDeadline = Date.now() + (wantFlag(request.query.wait) ? config.downloadWaitMs : 35_000);
    let started;
    for (;;) {
      try {
        started = await upstream.startPlaylistDownload(
          data.playlist_info,
          data.tracks ?? [],
          { lang }
        );
        break;
      } catch (err) {
        if (err.code !== "no_slots") throw err;
        const remainMs = startDeadline - Date.now();
        const waitMs = Math.min((err.retryAfter || 25) * 1000, remainMs);
        if (waitMs <= 0) {
          err.statusCode = 429;
          throw err;
        }
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    const statusUrl = `${baseUrl(request)}/api/download/status?task_id=${encodeURIComponent(started.task_id)}`;
    const zipUrl = `${baseUrl(request)}/api/download/zip?task_id=${encodeURIComponent(started.task_id)}`;

    if (!wantFlag(request.query.wait)) {
      reply.header("x-cache", hit);
      return {
        task_id: started.task_id,
        status: "started",
        total_tracks: data.tracks?.length ?? 0,
        status_url: statusUrl,
        zip_url: zipUrl,
      };
    }

    const done = new Set(["completed", "completed_with_errors", "creating_zip"]);
    const failed = new Set(["failed", "error", "not_found", "cancelled"]);
    const deadline = Date.now() + config.downloadWaitMs;
    let status = { status: "started" };

    while (Date.now() < deadline) {
      status = await upstream.downloadStatus(started.task_id);
      if (done.has(status.status) || failed.has(status.status)) break;
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!done.has(status.status)) {
      reply.header("x-cache", hit);
      return {
        task_id: started.task_id,
        status: status.status ?? "downloading",
        total_tracks: data.tracks?.length ?? 0,
        downloaded_tracks: status.downloaded_tracks ?? 0,
        failed_tracks: status.failed_tracks ?? 0,
        status_url: statusUrl,
        zip_url: zipUrl,
        meta: { cache: hit, waited_ms: Math.round(performance.now() - (deadline - config.downloadWaitMs)) },
      };
    }

    const zip = await upstream.createZip(started.task_id);
    const fileUrl = zip.download_now_url ?? zip.zip_url ?? null;
    reply.header("x-cache", hit);
    return {
      task_id: started.task_id,
      status: status.status,
      total_tracks: status.total_tracks ?? data.tracks?.length ?? 0,
      downloaded_tracks: status.downloaded_tracks ?? null,
      failed_tracks: status.failed_tracks ?? null,
      filename: zip.filename ?? null,
      filesize: zip.filesize ?? zip.file_size ?? null,
      zip_url: fileUrl,
      download_url: fileUrl,
      raw: zip,
    };
  });

  app.get("/api/download/status", async (request) => {
    const taskId = request.query.task_id;
    if (!taskId) {
      const err = new Error("task_id query parameter is required");
      err.statusCode = 400;
      err.code = "missing_task_id";
      throw err;
    }
    return upstream.downloadStatus(String(taskId));
  });

  app.get("/api/download/zip", async (request, reply) => {
    const taskId = request.query.task_id;
    if (!taskId) {
      const err = new Error("task_id query parameter is required");
      err.statusCode = 400;
      err.code = "missing_task_id";
      throw err;
    }
    const zip = await upstream.createZip(String(taskId));
    const fileUrl = zip.download_now_url ?? zip.zip_url ?? null;
    if (wantFlag(request.query.redirect) && fileUrl) {
      return reply.redirect(fileUrl, 302);
    }
    return {
      task_id: String(taskId),
      status: zip.status ?? null,
      filename: zip.filename ?? null,
      filesize: zip.filesize ?? zip.file_size ?? null,
      zip_url: fileUrl,
      download_url: fileUrl,
      raw: zip,
    };
  });

  // Legacy paths now do the real work.
  app.get("/v1/tracks/:id", async (request, reply) => {
    return reply.redirect(
      `/api/download?url=${encodeURIComponent(request.params.id)}${request.query.redirect ? "&redirect=1" : ""}`,
      307
    );
  });

  app.get("/v1/playlist/:id/download", async (request, reply) => {
    return reply.redirect(
      `/api/download/playlist?url=${encodeURIComponent(request.params.id)}${request.query.wait ? "&wait=1" : ""}`,
      307
    );
  });

  // ----------------------------------------------------------------- errors

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? (error instanceof UpstreamError ? error.status : 500);
    const payload = {
      code: error.code ?? (error instanceof UpstreamError ? error.code : "internal_error"),
      message: error.message,
      request_id: request.id,
    };
    if (status === 403 || /request_token_http_403/.test(error.message)) {
      payload.hint =
        "Upstream Cloudflare is blocking this host's IP. Set PROXY_URL to a residential/mobile proxy, or run the API on a residential connection.";
      payload.diagnose_url = "/api/diagnose";
    }
    if (payload.code === "no_slots") {
      payload.hint = "Upstream download queue is full. Retry in a minute or use per-track downloads.";
    }
    if (error.retryAfter) {
      payload.retry_after_seconds = error.retryAfter;
      reply.header("retry-after", String(error.retryAfter));
    }
    if (status >= 500) request.log.error({ err: error }, "request failed");
    reply.status(status).send(payload);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!config.apiKeys.length) return;
    if (request.url.split("?")[0] === "/health") return;
    const key = request.headers["x-api-key"];
    if (!config.apiKeys.includes(key)) {
      reply.status(401).send({ code: "unauthorized", message: "Invalid or missing x-api-key" });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.decorate("upstream", upstream);
  app.decorate("cache", cache);
  return app;
}
