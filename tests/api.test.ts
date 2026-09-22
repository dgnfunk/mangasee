import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
import { DemoSource, Komga } from "../server/komga.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const origin = "http://localhost:3000";
test("auth, CSRF, content bounds, version conflict and missing library are enforced", async () => {
  let libraryAvailable = true;
  const { app, store, sync } = await createApp({
    database: ":memory:",
    password: "long-test-password",
    origin,
    secure: false,
    demo: true,
    libraryCheck: async () => libraryAvailable,
    source: new DemoSource(),
  });
  try {
    await sync();
    assert.equal((await app.inject("/api/books")).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/session/login",
          payload: { password: "long-test-password" },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/session/login",
      headers: { origin },
      payload: { password: "long-test-password" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies[0];
    assert.equal(cookie.httpOnly, true);
    const headers = { origin, cookie: `session=${cookie.value}` };
    assert.equal(
      (await app.inject({ url: "/api/status", headers })).json().library,
      true,
    );
    const catalog = await app.inject({ url: "/api/books", headers });
    assert.equal(catalog.json().total, 12);
    const id = catalog.json().items[0].id;
    assert.equal(
      (await app.inject({ url: `/api/books/${id}/page/999`, headers }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/books/${id}/page/1?revision=old`,
          headers,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await app.inject({ url: `/api/books/${id}/page/1`, headers }))
        .statusCode,
      200,
    );
    const payload = {
      page: 3,
      cfi: null,
      completed: false,
      baseVersion: 0,
      mutationId: randomUUID(),
    };
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/api/books/${id}/progress`,
          headers,
          payload,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/api/books/${id}/progress`,
          headers,
          payload: { ...payload, mutationId: randomUUID() },
        })
      ).statusCode,
      409,
    );
    libraryAvailable = false;
    assert.equal(
      (await app.inject({ url: "/api/status", headers })).json().library,
      false,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/sync", headers }))
        .statusCode,
      400,
    );
    assert.equal(store.list({ status: "unavailable" }).total, 0);
    assert.equal(store.list({}).total, 12);
    await app.inject({ method: "POST", url: "/api/session/logout", headers });
    assert.equal(
      (await app.inject({ url: "/api/books", headers })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test("failed source refresh keeps the previous catalog", async () => {
  const source = new DemoSource();
  const { app, store, sync } = await createApp({
    database: ":memory:",
    password: "long-test-password",
    origin,
    secure: false,
    demo: true,
    libraryCheck: async () => true,
    source,
  });
  try {
    await sync();
    source.catalog = async () => {
      throw new Error("Network failed on second page");
    };
    await assert.rejects(sync);
    assert.equal(store.list({}).total, 12);
    assert.equal(store.list({ status: "unavailable" }).total, 0);
  } finally {
    await app.close();
  }
});
test("Komga adapter uses authenticated POST pagination and explicit image negotiation", async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    requests.push({
      url: req.url,
      key: req.headers["x-api-key"],
      method: req.method,
      accept: req.headers.accept,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/api/v1/books/list")) {
      res.end(
        JSON.stringify({
          content: [
            {
              id: "1",
              url: "/library/a.cbz",
              name: "A",
              fileHash: "abc",
              metadata: { title: "A", summary: "" },
              media: { status: "READY", pagesCount: 2 },
            },
          ],
          totalElements: 1,
          last: true,
        }),
      );
    } else if (req.url?.endsWith("/pages"))
      res.end(JSON.stringify([{ number: 1, width: 800, height: 1200 }]));
    else {
      res.setHeader("Content-Type", "image/jpeg");
      res.end("image");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address() as any;
    const source = new Komga(`http://127.0.0.1:${address.port}`, "secret");
    assert.equal((await source.catalog())[0].format, "CBZ");
    assert.equal((await source.pages("1"))[0].number, 1);
    await (await source.content("1", "page", 1)).arrayBuffer();
    assert.equal(requests[0].method, "POST");
    assert.ok(requests.every((r) => r.key === "secret"));
    assert.match(requests[2].url, /convert=jpeg&zero_based=false/);
    assert.equal(requests[2].accept, "image/jpeg");
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});

test("encoded API routes cannot bypass authentication or origin checks", async () => {
  const { app, sync, store } = await createApp({
    database: ":memory:",
    password: "long-test-password",
    origin,
    secure: true,
    demo: true,
    libraryCheck: async () => true,
    source: new DemoSource(),
  });
  try {
    await sync();
    const id = store.list({}).items[0].id;
    for (const path of [
      "/%61pi/books",
      "/a%70i/books",
      "/%61pi/series",
      "/%61pi/collections",
      "/%61pi/status",
      `/%61pi/books/${id}/page/1`,
    ]) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 401, path);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    const login = await app.inject({
      method: "POST",
      url: "/api/session/login",
      headers: { origin },
      payload: { password: "long-test-password" },
    });
    assert.equal(login.cookies[0].secure, true);
    const cookie = `session=${login.cookies[0].value}`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/%61pi/series",
          headers: { cookie, origin: "https://untrusted.example" },
          payload: { title: "Must not exist" },
        })
      ).statusCode,
      403,
    );
    assert.equal(store.series().length, 0);
    const content = await app.inject({
      url: `/api/books/${id}/page/1?revision=demo-v1`,
      headers: { cookie },
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.headers["cache-control"], "no-store");
    await app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { cookie, origin },
    });
    assert.equal(
      (
        await app.inject({
          url: `/%61pi/books/${id}/page/1`,
          headers: { cookie },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
