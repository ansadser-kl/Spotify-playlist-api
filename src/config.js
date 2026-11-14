import "dotenv/config";

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

// Temporary residential relay: Render's IP is challenged by upstream
// Cloudflare, so Render instances forward upstream calls through this tunnel.
// Disable with UPSTREAM_RELAY="" or by overriding UPSTREAM_RELAY.
const RESIDENTIAL_RELAY = "https://chip-actually-universe-moved.trycloudflare.com/relay";
const RELAY_KEY = "a4bb61312dacf5a932cb557fea088e2a";

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: num(process.env.PORT, 8080),
  logLevel: process.env.LOG_LEVEL ?? "info",

  upstreamBase: (process.env.UPSTREAM_BASE ?? "https://spotisaver.net").replace(/\/$/, ""),
  // On Render, transparently tunnel upstream calls through a residential host.
  upstreamRelay: (
    process.env.UPSTREAM_RELAY ?? (process.env.RENDER ? RESIDENTIAL_RELAY : "")
  ).replace(/\/$/, ""),
  relayKey: process.env.RELAY_KEY ?? RELAY_KEY,
  // Outbound proxy for datacenter hosts blocked by upstream Cloudflare.
  proxyUrl: process.env.PROXY_URL ?? process.env.HTTPS_PROXY ?? "",
  userAgent:
    process.env.USER_AGENT ??
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  defaultLang: process.env.DEFAULT_LANG ?? "en",
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 25_000),
  maxRetries: num(process.env.MAX_RETRIES, 2),

  // More sessions = more upstream parallelism (PHP serializes per session).
  sessionPoolSize: num(process.env.SESSION_POOL_SIZE, 8),
  // Upstream signature tokens live ~120s; renew slightly early.
  signatureTtlSkewMs: num(process.env.SIGNATURE_TTL_SKEW_MS, 15_000),

  // Global cap on in-flight upstream calls.
  maxConcurrent: num(process.env.MAX_CONCURRENT, 16),

  // Download backend is slot-limited; keep it gentle and retry.
  downloadConcurrency: num(process.env.DOWNLOAD_CONCURRENCY, 2),
  downloadRetries: num(process.env.DOWNLOAD_RETRIES, 4),
  downloadRetryDelayMs: num(process.env.DOWNLOAD_RETRY_DELAY_MS, 4000),
  downloadWaitMs: num(process.env.DOWNLOAD_WAIT_MS, 90_000),
  userIp: process.env.USER_IP ?? "",

  cacheTtlMs: num(process.env.CACHE_TTL_MS, 10 * 60_000),
  cacheMax: num(process.env.CACHE_MAX, 2000),
  // Expired playlists are still served instantly for this long while refreshing.
  cacheStaleMs: num(process.env.CACHE_STALE_MS, 60 * 60_000),

  batchConcurrency: num(process.env.BATCH_CONCURRENCY, 8),
  batchMaxIds: num(process.env.BATCH_MAX_IDS, 25),

  apiKeys: list(process.env.API_KEYS),
  rateLimitMax: num(process.env.RATE_LIMIT_MAX, 120),
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
};

export const DEFAULTS = {
  wire: {
    token_param: "k8019d37393",
    ctx_param: "c54c378d121",
    action_param: "a6f986db872",
    sig_header: "X-S25604586",
    exp_header: "X-E58CF69B2",
    actions: {
      get_playlist: "x1be168a1df",
      download_track: "x7a3147eaaa",
      download_playlist: "x4c1dad95c4",
    },
  },
};
