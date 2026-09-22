import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createApp } from "./app.js";
import { DemoSource, Komga } from "./komga.js";
try {
  process.loadEnvFile();
} catch {}
const demo = process.env.DEMO_MODE === "true";
const password = process.env.APP_PASSWORD;
if (!password || password.length < 12)
  throw new Error("Set APP_PASSWORD to at least 12 characters in .env");
const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
const database = process.env.DATABASE_PATH ?? "data/mangasee.sqlite";
mkdirSync(dirname(database), { recursive: true });
if (!demo && (!process.env.KOMGA_URL || !process.env.KOMGA_API_KEY))
  throw new Error(
    "Configure KOMGA_URL and KOMGA_API_KEY, or explicitly set DEMO_MODE=true for fixtures",
  );
let pendingLibraryRead: Promise<string> | undefined;
const libraryCheck = async () => {
  if (demo) return true;
  try {
    pendingLibraryRead ??= readFile(
      process.env.LIBRARY_SENTINEL ??
        process.env.NAS_SENTINEL ??
        join(process.env.LIBRARY_PATH ?? "/library", ".mangasee-library"),
      "utf8",
    ).finally(() => {
      pendingLibraryRead = undefined;
    });
    const result = await Promise.race([
      pendingLibraryRead,
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("Library check timed out")),
          3000,
        );
        t.unref();
      }),
    ]);
    return (
      result.trim() ===
      (process.env.LIBRARY_SENTINEL_VALUE ??
        process.env.NAS_SENTINEL_VALUE ??
        "mangasee-library")
    );
  } catch {
    return false;
  }
};
const { app, sync } = await createApp({
  database,
  password,
  origin,
  secure: origin.startsWith("https:"),
  demo,
  libraryCheck,
  source: demo
    ? new DemoSource(Number(process.env.DEMO_BOOKS ?? 12))
    : new Komga(process.env.KOMGA_URL!, process.env.KOMGA_API_KEY!),
  logger: true,
});
await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",
});
void sync().catch((e) => app.log.warn(e.message));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
