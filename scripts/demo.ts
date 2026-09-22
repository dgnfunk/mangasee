import { mkdirSync } from "node:fs";
import { createApp } from "../server/app.js";
import { DemoSource } from "../server/komga.js";
mkdirSync("data", { recursive: true });
const { app, sync } = await createApp({
  database: "data/demo.sqlite",
  password: "mangasee-demo",
  origin: "http://localhost:3000",
  secure: false,
  demo: true,
  libraryCheck: async () => true,
  source: new DemoSource(),
  logger: true,
});
await sync();
await app.listen({ port: 3000, host: "127.0.0.1" });
console.log(
  "Local demo: http://localhost:3000 — password: mangasee-demo (demo fixtures only)",
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
