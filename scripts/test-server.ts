import { readFile } from "node:fs/promises";
import { createApp } from "../server/app.js";
import { DemoSource } from "../server/komga.js";
class TestSource extends DemoSource {
  async catalog() {
    const books = await super.catalog();
    for (const [index, name] of [
      [10, "Reflow EPUB"],
      [11, "Fixed EPUB"],
    ] as const) {
      books[index] = { ...books[index], title: name, format: "EPUB", pages: 2 };
    }
    return books;
  }
  async content(id: string, kind: "cover" | "file" | "page", page = 1) {
    if (kind === "file" && (id === "demo-10" || id === "demo-11"))
      return new Response(
        await readFile(
          `tests/fixtures/${id === "demo-10" ? "reflow" : "fixed"}.epub`,
        ),
        { headers: { "Content-Type": "application/epub+zip" } },
      );
    return super.content(id, kind, page);
  }
}
const { app, sync, store } = await createApp({
  database: ":memory:",
  password: "mangasee-test-password",
  origin: "http://127.0.0.1:4173",
  secure: false,
  demo: true,
  libraryCheck: async () => true,
  source: new TestSource(),
  logger: false,
  loginLimit: 100,
});
app.post("/api/testing/reset", async () => {
  store.db.exec(
    "DELETE FROM collections; DELETE FROM series; DELETE FROM books; DELETE FROM mutations;",
  );
  await sync();
  return { ok: true };
});
await sync();
await app.listen({ port: 4173, host: "127.0.0.1" });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
