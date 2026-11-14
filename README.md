# SpotifyDL API

Fast, caching HTTP API in front of the spotisaver resolve flow. Turns a Spotify
playlist URL/ID into clean JSON (playlist + tracks) in one call — with a session
pool, signature caching, response caching and single-flight de-duplication.

```
client ──► Fastify API ──► session pool (N PHP sessions)
                 │              │
                 │              ├─ GET /api/get_request_token.php   (per session)
                 │              ├─ GET /api/get_signature.php       (~120s TTL, id-bound)
                 │              └─ GET /api/get_playlist.php        (X-S…/X-E… headers)
                 └─ TTL+LRU cache, single-flight, gzip, rate limit
```

## Quick start

```bash
cp .env.example .env
npm install
npm start            # http://localhost:8080
npm run bench        # cold / warm / batch timings
```

Requires Node.js >= 20 (uses global `fetch`, no native builds).

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Status, cache stats, session pool state, wire config |
| GET | `/api/playlist?url=` | **Recommended** — playlist, album or track URL; type auto-detected, includes download links |
| GET | `/api/download?url=` | Direct MP3 link for one track (`&redirect=1` = 302 to the file) |
| GET | `/api/download/playlist?url=` | Start a zip task (`&wait=1` polls up to `DOWNLOAD_WAIT_MS`) |
| GET | `/api/download/status?task_id=` | Task progress |
| GET | `/api/download/zip?task_id=` | Create/fetch the zip after the task completes |
| GET | `/v1/playlist/:id` | Playlist by ID, URI or URL. Query: `lang`, `type`, `limit`, `offset`, `raw=1` |
| GET | `/v1/playlist/:id/search?q=` | Filter tracks by name / artist / album |
| GET | `/v1/resolve?url=` | Same as above, but takes a full Spotify URL |
| POST | `/v1/playlists` | Batch resolve: `{ "ids": ["…"], "lang": "en" }` (max 25) |
| GET | `/v1/tracks/:id` | Redirects to `/api/download` |
| GET | `/v1/playlist/:id/download` | Redirects to `/api/download/playlist` |

```bash
# playlist / album / track metadata (each track gets download_url + download_info_url)
curl -G localhost:8080/api/playlist \
  --data-urlencode 'url=https://open.spotify.com/playlist/6sawsCEsNibodILrvtg2AV'

# resolve a real MP3 link for one track (slow: upstream is slot-limited)
curl -G localhost:8080/api/download \
  --data-urlencode 'url=https://open.spotify.com/track/7hY1frmgrgWzlGsOZ3YYpf'

# same, but redirect straight to the file (paste in a browser)
curl -L -G localhost:8080/api/download \
  --data-urlencode 'url=https://open.spotify.com/track/7hY1frmgrgWzlGsOZ3YYpf' \
  --data-urlencode 'redirect=1'

# playlist zip (slow; waits for the upstream task then creates the archive)
curl -G localhost:8080/api/download/playlist \
  --data-urlencode 'url=https://open.spotify.com/playlist/6sawsCEsNibodILrvtg2AV' \
  --data-urlencode 'wait=1'

curl 'localhost:8080/v1/playlist/6sawsCEsNibodILrvtg2AV?limit=5'
curl -X POST localhost:8080/v1/playlists -H 'content-type: application/json' \
     -d '{"ids":["6sawsCEsNibodILrvtg2AV","37i9dQZF1DXcBWIGoYBM5M"]}'
```

Responses include `x-cache: HIT|MISS|STALE`, `server-timing: upstream;dur=…` and
`x-request-id`. Playlist payloads are cached for `CACHE_TTL_MS` (default 10 min);
after expiry they are served instantly as `STALE` while a background refresh runs.
Pass `?refresh=1` to force a re-fetch.

## How the upstream auth works (as observed)

1. `GET /api/get_request_token.php` → `request_token`, tied to the `PHPSESSID`
   cookie set by that response.
2. `GET /api/get_signature.php?k=<request_token>&c=<base64url JSON {id,type,lang}>&a=<action>`
   → `{ token, exp }`. `exp` is ~120 s ahead and the token is **bound to that
   playlist id**.
3. `GET /api/get_playlist.php?id=…&type=playlist&lang=en` with headers
   `X-S25604586: <token>` and `X-E58CF69B2: <exp>` (names rotate with the
   signing key, so they are scraped from `/en1` at startup and refreshed on
   signature failures).

Because PHP sessions serialize, the API keeps a pool of independent sessions
(`SESSION_POOL_SIZE`) and pins each playlist to one session so its signature can
be reused. Concurrent identical requests collapse via single-flight.

## Configuration

All settings are env vars (see `.env.example`):

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `UPSTREAM_BASE` | `https://spotisaver.net` | Upstream origin |
| `SESSION_POOL_SIZE` | `8` | Independent upstream sessions |
| `MAX_CONCURRENT` | `16` | Global in-flight upstream cap |
| `REQUEST_TIMEOUT_MS` | `25000` | Per upstream request |
| `SIGNATURE_TTL_SKEW_MS` | `15000` | Renew signatures early |
| `CACHE_TTL_MS` / `CACHE_MAX` | `600000` / `2000` | Playlist cache |
| `CACHE_STALE_MS` | `3600000` | Serve stale instantly while revalidating |
| `DOWNLOAD_CONCURRENCY` | `2` | Parallel track downloads (upstream slots are scarce) |
| `DOWNLOAD_RETRIES` / `DOWNLOAD_RETRY_DELAY_MS` | `4` / `4000` | Retry "No available slots" |
| `DOWNLOAD_WAIT_MS` | `90000` | Max block time for `/api/download/playlist?wait=1` |
| `USER_IP` | *(empty)* | Public IP forwarded to the download backend |
| `BATCH_CONCURRENCY` / `BATCH_MAX_IDS` | `8` / `25` | Batch endpoint limits |
| `API_KEYS` | *(empty)* | Comma-separated `x-api-key` values; empty = auth off |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `120` / `1 minute` | Per-IP limit |
| `CORS_ORIGIN` | `*` | Allowed origin(s) |

## Docker

```bash
docker build -t spotifydl .
docker run -p 8080:8080 --env-file .env spotifydl
```

## Downloads

- `download_track` (`a=x7a3147eaaa`) → `POST /api/download_track.php` returns
  `{ download_url, filename, relay }`. Links expire (~5 min), so the API caches
  them only until just before `relay.exp`.
- `download_playlist` (`a=x4c1dad95c4`) → `POST /api/download_playlist.php`
  returns `{ task_id }`; poll `GET /api/get_download_status.php?task_id=…`;
  when the status is `completed` / `completed_with_errors` / `creating_zip`,
  `POST /api/create_zip.php` returns `{ zip_url, download_now_url, … }`.

The backend is slot-limited and a single track can take 5–20 s, so playlist
zips are inherently long. Use `?wait=1` for a blocking call, or start the task
and poll `/api/download/status` yourself. `/api/playlist` always returns a
ready-made `download_url` per track (resolved lazily on click) plus `zip_url`
and `zip_wait_url` in its `download` block.

## Legal

This is an unofficial client for a third-party service. Downloading audio from
Spotify may violate Spotify's Terms of Service and copyright law in your
country. Use it for personal, lawful purposes only and at your own risk.
