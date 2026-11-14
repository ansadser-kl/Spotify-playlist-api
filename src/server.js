import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

app.upstream
  .prewarm()
  .then((n) => app.log.info(`prewarmed ${n}/${app.upstream.pool.size} upstream sessions`))
  .catch((err) => app.log.warn({ err }, "prewarm failed"));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
