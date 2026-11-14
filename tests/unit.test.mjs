import test from "node:test";
import assert from "node:assert/strict";

import { detectSpotifyType, extractSpotifyId, normalizePlaylist, decodeEntities } from "../src/normalize.js";
import { extractJsonObject } from "../src/upstream.js";
import { TTLCache, Semaphore } from "../src/cache.js";

test("extractSpotifyId handles url, uri and bare id", () => {
  const id = "6sawsCEsNibodILrvtg2AV";
  assert.equal(extractSpotifyId(`https://open.spotify.com/playlist/${id}?si=abc`), id);
  assert.equal(extractSpotifyId(`spotify:playlist:${id}`), id);
  assert.equal(extractSpotifyId(id), id);
  assert.equal(extractSpotifyId("https://example.com/nope"), null);
  assert.equal(extractSpotifyId(""), null);
});

test("detectSpotifyType + track/album urls", () => {
  assert.equal(detectSpotifyType("https://open.spotify.com/track/1QjXwGvMfjlFdGCnBSfTcD"), "track");
  assert.equal(detectSpotifyType("https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=x"), "album");
  assert.equal(detectSpotifyType("spotify:playlist:6sawsCEsNibodILrvtg2AV"), "playlist");
  assert.equal(detectSpotifyType("6sawsCEsNibodILrvtg2AV"), null);
  assert.equal(extractSpotifyId("https://open.spotify.com/track/1QjXwGvMfjlFdGCnBSfTcD"), "1QjXwGvMfjlFdGCnBSfTcD");
  assert.equal(extractSpotifyId("https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy"), "4aawyAB9vmqN3uQ7FjRGTy");
});

test("decodeEntities decodes the common ones", () => {
  assert.equal(decodeEntities("a &amp; b &quot;c&quot;"), 'a & b "c"');
});

test("normalizePlaylist maps upstream shape", () => {
  const raw = {
    playlist_info: {
      id: "x",
      name: "Test &amp; More",
      total_tracks: 1,
      images: [{ url: "https://img/1" }],
      from_source: "spotify",
    },
    tracks: [
      {
        id: "t1",
        name: "Song",
        artists: ["A"],
        album: "Alb",
        image: { url: "https://img/t" },
        duration_ms: 1000,
        explicit: 0,
        position: 1,
      },
    ],
    excluded_tracks: [{ id: "t2", name: "Gone", reason: "unavailable", position: 2 }],
    duplicates: 2,
    from_cache: false,
  };
  const out = normalizePlaylist(raw);
  assert.equal(out.name, "Test & More");
  assert.equal(out.images[0], "https://img/1");
  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0].duration_ms, 1000);
  assert.equal(out.excluded_tracks[0].reason, "unavailable");
  assert.equal(out.duplicates, 2);
});

test("extractJsonObject is string-aware", () => {
  const text = 'x = {"a":"}{","b":{"c":1}}; tail';
  const start = text.indexOf("{");
  assert.equal(extractJsonObject(text, start), '{"a":"}{","b":{"c":1}}');
});

test("TTLCache expires entries", async () => {
  const cache = new TTLCache({ max: 2, ttlMs: 20 });
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cache.get("a"), undefined);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.set("d", 4);
  assert.equal(cache.get("b"), undefined); // LRU evicted
});

test("Semaphore limits concurrency", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      release();
    })
  );
  assert.equal(peak, 2);
});
