import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Store } from "./store.js";
import type { CatalogSource } from "./komga.js";
export type AppConfig = {
  database: string;
  password: string;
  origin: string;
  secure: boolean;
  demo: boolean;
  libraryCheck: () => Promise<boolean>;
  source: CatalogSource;
  staticRoot?: string;
  logger?: boolean;
  loginLimit?: number;
};
const title = z.string().trim().min(1).max(300),
  id = z.string().min(1).max(100);
const preferences = z.object({
  direction: z.enum(["rtl", "ltr"]),
  mode: z.enum(["single", "double", "vertical"]),
  fit: z.enum(["page", "width"]),
  offset: z.number().int().min(0).max(1),
});
export async function createApp(config: AppConfig) {
  const app = Fastify({
    logger: config.logger ?? false,
    bodyLimit: 1024 * 1024,
  });
  const store = new Store(config.database);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const salt = randomBytes(16);
  const password = scryptSync(config.password, salt, 32);
  let syncing = false;
  let syncError: string | null = null;
  const fingerprint = scryptSync(
    config.password,
    "mangasee-password-version",
    32,
  ).toString("hex");
  if (store.getState("passwordFingerprint") !== fingerprint) {
    store.db.exec("DELETE FROM sessions");
    store.setState("passwordFingerprint", fingerprint);
  }
  const tokenHash = (token: string) =>
    createHash("sha256").update(token).digest("hex");
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob:; font-src 'self' blob: data:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      );
    // Match the route Fastify actually resolved, not the raw URL: encoded
    // static segments such as /%61pi/books resolve to /api/books too.
    const route = req.routeOptions.url ?? req.url.split("?")[0];
    if (!route.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      return reply.code(403).send({ message: "Request origin is not allowed" });
    if (route === "/api/health" || route === "/api/session/login") return;
    const token = req.cookies.session;
    const session =
      token &&
      (store.db
        .prepare("SELECT expires FROM sessions WHERE token=?")
        .get(tokenHash(token)) as { expires: number } | undefined);
    if (!session || session.expires < Date.now())
      return reply.code(401).send({ message: "Sign in to your reading room" });
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        message: error.issues
          .map((x) => `${x.path.join(".")}: ${x.message}`)
          .join("; "),
      });
    app.log.error(error);
    reply.code((error as any).statusCode ?? 400).send({
      message: error instanceof Error ? error.message : "Request failed",
    });
  });
  app.get("/api/health", async () => ({ ok: true }));
  app.post(
    "/api/session/login",
    {
      config: {
        rateLimit: { max: config.loginLimit ?? 8, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const body = z.object({ password: z.string().max(1024) }).parse(req.body);
      if (!timingSafeEqual(scryptSync(body.password, salt, 32), password))
        return reply.code(401).send({ message: "Incorrect password" });
      store.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
      const token = randomBytes(32).toString("hex");
      store.db
        .prepare("INSERT INTO sessions VALUES(?,?)")
        .run(tokenHash(token), Date.now() + 30 * 86400000);
      reply.setCookie("session", token, {
        httpOnly: true,
        secure: config.secure,
        sameSite: "strict",
        path: "/",
        maxAge: 30 * 86400,
      });
      return { ok: true };
    },
  );
  app.get("/api/session", async () => ({
    authenticated: true,
    demo: config.demo,
  }));
  app.post("/api/session/logout", async (req, reply) => {
    if (req.cookies.session)
      store.db
        .prepare("DELETE FROM sessions WHERE token=?")
        .run(tokenHash(req.cookies.session));
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  async function sync() {
    if (syncing) throw new Error("Refresh already running");
    syncing = true;
    try {
      if (!(await config.libraryCheck()))
        throw new Error(
          "Library folder unavailable. Existing catalog preserved.",
        );
      const books = await config.source.catalog();
      if (!(await config.libraryCheck()))
        throw new Error(
          "Library folder became unavailable during refresh. Existing catalog preserved.",
        );
      store.reconcile(books);
      syncError = null;
      return { count: books.length };
    } catch (e) {
      syncError = e instanceof Error ? e.message : "Refresh failed";
      throw e;
    } finally {
      syncing = false;
    }
  }
  app.post("/api/sync", sync);
  app.get("/api/status", async () => ({
    library: await config.libraryCheck(),
    komga: await config.source.health(),
    lastSync: store.getState("lastSync") ?? null,
    syncing,
    error: syncError,
    demo: config.demo,
    books: (store.db.prepare("SELECT COUNT(*) AS n FROM books").get() as any).n,
  }));
  app.get("/api/books", async (req) =>
    store.list(
      z
        .object({
          search: z.string().max(300).optional(),
          format: z.enum(["CBZ", "CBR", "PDF", "EPUB", "OTHER"]).optional(),
          status: z
            .enum(["reading", "unread", "completed", "unavailable"])
            .optional(),
          series: id.optional(),
          collection: id.optional(),
          page: z.coerce.number().int().min(0).default(0),
          size: z.coerce.number().int().min(1).max(200).default(36),
        })
        .parse(req.query),
    ),
  );
  function getBook(raw: unknown) {
    const key = z.object({ id }).parse(raw).id;
    const book = store.book(key);
    if (!book)
      throw Object.assign(new Error("Book not found"), { statusCode: 404 });
    return book;
  }
  app.get("/api/books/:id", async (req) => getBook(req.params));
  app.get(
    "/api/books/:id/next",
    async (req) => store.nextBook(getBook(req.params).id) ?? null,
  );
  app.patch("/api/books/:id", async (req) =>
    store.editBook(
      getBook(req.params).id,
      z
        .object({
          title: title.optional(),
          volume: z.string().max(100).optional(),
        })
        .parse(req.body),
    ),
  );
  app.post("/api/books/:id/relink", async (req) => {
    store.relink(
      getBook(req.params).id,
      z.object({ replacementId: id }).parse(req.body).replacementId,
    );
    return { ok: true };
  });
  app.get("/api/books/:id/pages", async (req) => {
    const b = getBook(req.params);
    if (!b.available) throw new Error("Book unavailable");
    return config.source.pages(b.komgaId);
  });
  for (const kind of ["cover", "file", "page"] as const) {
    app.get(
      `/api/books/:id/${kind}${kind === "page" ? "/:page" : ""}`,
      async (req, reply) => {
        const b = getBook(req.params);
        if (!b.available)
          return reply.code(404).send({ message: "Book unavailable" });
        const page =
          kind === "page"
            ? z
                .object({
                  page: z.coerce
                    .number()
                    .int()
                    .min(1)
                    .max(Math.max(1, b.pages)),
                })
                .parse(req.params).page
            : undefined;
        const query = z
          .object({ revision: z.string().optional() })
          .parse(req.query);
        if (query.revision && query.revision !== b.revision)
          return reply
            .code(409)
            .send({ message: "Book changed. Refresh its download." });
        const response = await config.source.content(b.komgaId, kind, page);
        if (!response.body) throw new Error("Empty content response");
        reply.type(
          response.headers.get("content-type") ?? "application/octet-stream",
        );
        // Only explicit offline downloads may persist book content. Ordinary
        // browser caching could otherwise serve it after session revocation.
        reply.header("Cache-Control", "no-store");
        return reply.send(Readable.fromWeb(response.body as any));
      },
    );
  }
  app.get("/api/series", async () => store.series());
  app.post("/api/series", async (req) => ({
    id: store.saveSeries(undefined, z.object({ title }).parse(req.body).title),
  }));
  app.patch("/api/series/:id", async (req) => {
    const body = z
      .object({ title, preferences: preferences.optional() })
      .parse(req.body);
    return {
      id: store.saveSeries(
        z.object({ id }).parse(req.params).id,
        body.title,
        body.preferences,
      ),
    };
  });
  app.delete("/api/series/:id", async (req) => {
    store.deleteSeries(z.object({ id }).parse(req.params).id);
    return { ok: true };
  });
  app.post("/api/series/:id/books", async (req) => {
    store.assign(
      z.object({ id }).parse(req.params).id,
      z.object({ bookIds: z.array(id).min(1).max(1000) }).parse(req.body)
        .bookIds,
    );
    return { ok: true };
  });
  app.put("/api/series/:id/order", async (req) => {
    store.reorder(
      z.object({ id }).parse(req.params).id,
      z.object({ bookIds: z.array(id).max(10000) }).parse(req.body).bookIds,
    );
    return { ok: true };
  });
  app.delete("/api/books/:id/series", async (req) => {
    store.unassign(getBook(req.params).id);
    return { ok: true };
  });
  app.get("/api/collections", async () => store.collections());
  app.post("/api/collections", async (req) => {
    const b = z.object({ title, seriesIds: z.array(id) }).parse(req.body);
    return { id: store.saveCollection(undefined, b.title, b.seriesIds) };
  });
  app.put("/api/collections/:id", async (req) => {
    const b = z.object({ title, seriesIds: z.array(id) }).parse(req.body);
    return {
      id: store.saveCollection(
        z.object({ id }).parse(req.params).id,
        b.title,
        b.seriesIds,
      ),
    };
  });
  app.delete("/api/collections/:id", async (req) => {
    store.deleteCollection(z.object({ id }).parse(req.params).id);
    return { ok: true };
  });
  app.get("/api/books/:id/progress", async (req) =>
    store.progress(getBook(req.params).id),
  );
  app.put("/api/books/:id/progress", async (req, reply) => {
    const b = z
      .object({
        page: z.number().int().min(1),
        cfi: z.string().max(4096).nullable(),
        completed: z.boolean(),
        baseVersion: z.number().int().min(0),
        mutationId: z.string().uuid(),
      })
      .parse(req.body);
    const result = store.saveProgress({ ...b, bookId: getBook(req.params).id });
    return reply.code(result.conflict ? 409 : 200).send(result);
  });
  const root = config.staticRoot ?? resolve("dist");
  if (existsSync(root)) {
    await app.register(staticFiles, { root });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ message: "Endpoint not found" })
        : reply.sendFile("index.html"),
    );
  }
  const interval = setInterval(
    () => sync().catch((e) => app.log.warn(e.message)),
    15 * 60 * 1000,
  );
  interval.unref();
  app.addHook("onClose", async () => {
    clearInterval(interval);
    store.close();
  });
  return { app, store, sync };
}
