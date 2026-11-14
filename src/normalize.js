const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

export const decodeEntities = (s) =>
  typeof s === "string" ? s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m) : s;

export function normalizeTrack(t) {
  return {
    id: t.id,
    name: decodeEntities(t.name),
    artists: t.artists ?? [],
    album: decodeEntities(t.album),
    image: t.image?.url ?? null,
    thumb: t.thumb_image?.url ?? null,
    duration_ms: t.duration_ms ?? null,
    explicit: Boolean(t.explicit),
    release_date: t.release_date ?? null,
    added_at: t.added_at ?? null,
    position: t.position ?? null,
    playcount: t.playcount ?? null,
    bpm: t.bpm ?? null,
    key: t.key ?? null,
    mode: t.mode ?? null,
    camelot_key: t.camelot_key ?? null,
    media_type: t.media_type ?? null,
    track_number: t.track_number ?? null,
    disc_number: t.disc_number ?? null,
    external_url: t.external_url ?? null,
  };
}

export function normalizePlaylist(raw) {
  const info = raw?.playlist_info ?? {};
  return {
    id: info.id,
    name: decodeEntities(info.name),
    description: decodeEntities(info.description),
    owner: info.owner ?? null,
    type: info.type ?? "playlist",
    source: info.from_source ?? "spotify",
    external_url: info.external_url ?? null,
    images: (info.images ?? []).map((i) => (typeof i === "string" ? i : i.url)).filter(Boolean),
    followers: info.followers ?? null,
    total_tracks: info.total_tracks ?? raw?.tracks?.length ?? 0,
    source_total_tracks: info.source_total_tracks ?? null,
    track_limit: info.track_limit ?? null,
    total_duration_ms: info.total_duration_ms ?? null,
    premium_loaded: Boolean(info.premium_loaded),
    upstream_cached: Boolean(raw?.from_cache),
    duplicates: raw?.duplicates ?? 0,
    tracks: (raw?.tracks ?? []).map(normalizeTrack),
    excluded_tracks: (raw?.excluded_tracks ?? []).map((t) => ({
      id: t.id ?? null,
      name: decodeEntities(t.name),
      artists: t.artists ?? [],
      reason: t.reason ?? null,
      position: t.position ?? null,
    })),
  };
}

const TYPE_PATTERNS = [
  ["playlist", /playlist[/:]([A-Za-z0-9]+)/],
  ["album", /album[/:]([A-Za-z0-9]+)/],
  ["track", /track[/:]([A-Za-z0-9]+)/],
];

/** Detects playlist / album / track from a Spotify URL or URI. */
export function detectSpotifyType(input) {
  const s = String(input ?? "");
  for (const [type, pattern] of TYPE_PATTERNS) {
    if (pattern.test(s)) return type;
  }
  return null;
}

/** Accepts a Spotify URL, URI, or bare id and returns the id. */
export function extractSpotifyId(input, type) {
  if (!input) return null;
  const s = String(input).trim();
  const kind = type ?? detectSpotifyType(s);

  if (kind) {
    const match = s.match(new RegExp(`${kind}[/:]([A-Za-z0-9]+)`));
    if (match) return match[1];
  }

  const uri = s.match(/^spotify:(?:playlist|album|track):([A-Za-z0-9]+)$/);
  if (uri) return uri[1];

  if (/^[A-Za-z0-9]{16,32}$/.test(s)) return s;
  return null;
}
