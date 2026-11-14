// Benchmark the local API with a keep-alive agent (accurate server timings).
import http from "node:http";

const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const IDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["6sawsCEsNibodILrvtg2AV", "37i9dQZF1DXcBWIGoYBM5M"];

const url = new URL(BASE);
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

function request(path, init = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        path,
        method: init.method ?? "GET",
        agent,
        headers: init.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            cache: res.headers["x-cache"],
            ms: performance.now() - started,
            body,
          })
        );
      }
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function one(id, label) {
  const r = await request(`/v1/playlist/${id}?limit=1`);
  const j = JSON.parse(r.body);
  console.log(
    `${label.padEnd(10)} ${r.status} ${r.ms.toFixed(0).padStart(6)}ms  cache=${r.cache ?? "-"}  tracks=${j.track_count ?? "?"}`
  );
}

console.log(`API: ${BASE}`);
await request("/health"); // warm the keep-alive socket
await one(IDS[0], "cold");
await one(IDS[0], "warm");

const t = performance.now();
const r = await request("/v1/playlists", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ids: IDS }),
});
const j = JSON.parse(r.body);
console.log(
  `batch x${IDS.length} ${r.status} ${(performance.now() - t).toFixed(0).padStart(6)}ms  ok=${j.results.filter((x) => x.ok).length}/${j.results.length}`
);

agent.destroy();
