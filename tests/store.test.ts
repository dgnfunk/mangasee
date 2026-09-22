import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { spreads } from "../src/reader-model.js";
import type { SourceBook } from "../src/types.js";
const source = (id: string): SourceBook => ({
  komgaId: id,
  title: `Book ${id}`,
  format: "CBZ",
  pages: 20,
  available: true,
  revision: "r1",
  summary: "",
});
const fixture = () => {
  const s = new Store(":memory:");
  s.reconcile([source("a"), source("b"), source("c")]);
  return s;
};
test("catalog refresh retains stable IDs, custom labels, memberships and progress", () => {
  const s = fixture();
  try {
    const a = s.list({}).items[0];
    const series = s.saveSeries(undefined, "Virtual series");
    s.assign(series, [a.id]);
    s.editBook(a.id, { title: "Custom", volume: "Chapter zero" });
    s.saveProgress({
      bookId: a.id,
      page: 7,
      cfi: null,
      completed: false,
      baseVersion: 0,
      mutationId: randomUUID(),
    });
    s.reconcile([{ ...source("a"), title: "New source name" }, source("b")]);
    assert.equal(s.book(a.id)?.title, "Custom");
    assert.equal(s.book(a.id)?.sourceTitle, "New source name");
    assert.equal(s.book(a.id)?.seriesId, series);
    assert.equal(s.book(a.id)?.progress.page, 7);
    assert.equal(s.list({ status: "unavailable" }).total, 1);
    assert.equal(s.list({}).total, 3);
  } finally {
    s.close();
  }
});
test("invalid reconciliation is atomic and never marks existing sources missing", () => {
  const s = fixture();
  try {
    assert.throws(() => s.reconcile([source("a"), source("a")]));
    assert.equal(s.list({ status: "unavailable" }).total, 0);
  } finally {
    s.close();
  }
});
test("ordering validates full membership and assigning across series is atomic", () => {
  const s = fixture();
  try {
    const ids = s.list({}).items.map((x) => x.id),
      a = s.saveSeries(undefined, "A"),
      b = s.saveSeries(undefined, "B");
    s.assign(a, ids);
    s.reorder(a, [...ids].reverse());
    assert.deepEqual(
      s.list({ series: a }).items.map((x) => x.id),
      [...ids].reverse(),
    );
    assert.throws(() => s.reorder(a, [ids[0], ids[0], ids[2]]));
    assert.throws(() => s.assign(b, [ids[0], "missing"]));
    assert.equal(s.book(ids[0])?.seriesId, a);
    s.assign(b, [ids[0]]);
    assert.equal(s.book(ids[0])?.seriesId, b);
    s.deleteSeries(a);
    assert.equal(s.list({ series: "unorganized" }).total, 2);
  } finally {
    s.close();
  }
});
test("progress detects competing devices and retries are idempotent", () => {
  const s = fixture();
  try {
    const bookId = s.list({}).items[0].id;
    const request = {
      bookId,
      page: 4,
      cfi: null,
      completed: false,
      baseVersion: 0,
      mutationId: randomUUID(),
    };
    assert.equal(s.saveProgress(request).progress?.version, 1);
    assert.equal(s.saveProgress(request).progress?.version, 1);
    const other = { ...request, page: 9, mutationId: randomUUID() };
    assert.equal(s.saveProgress(other).conflict?.page, 4);
    assert.equal(
      s.saveProgress({ ...other, baseVersion: 1 }).progress?.version,
      2,
    );
    assert.throws(() =>
      s.saveProgress({
        ...other,
        page: 99,
        baseVersion: 2,
        mutationId: randomUUID(),
      }),
    );
    assert.equal(s.progress(bookId).page, 9);
  } finally {
    s.close();
  }
});
test("manual relink keeps organization and history and removes replacement record", () => {
  const s = fixture();
  try {
    const old = s.list({}).items[0],
      replacement = s.list({}).items[1];
    const series = s.saveSeries(undefined, "Kept");
    s.assign(series, [old.id]);
    s.saveProgress({
      bookId: old.id,
      page: 10,
      cfi: null,
      completed: false,
      baseVersion: 0,
      mutationId: randomUUID(),
    });
    s.reconcile([source("b"), source("c")]);
    s.relink(old.id, replacement.id);
    assert.equal(s.book(old.id)?.komgaId, "b");
    assert.equal(s.book(old.id)?.progress.page, 10);
    assert.equal(s.book(old.id)?.seriesId, series);
    assert.equal(s.book(replacement.id), undefined);
  } finally {
    s.close();
  }
});
test("collections preserve referential integrity and filter books", () => {
  const s = fixture();
  try {
    const series = s.saveSeries(undefined, "A");
    s.assign(series, [s.list({}).items[0].id]);
    const c = s.saveCollection(undefined, "Favorites", [series]);
    assert.equal(s.list({ collection: c }).total, 1);
    assert.throws(() => s.saveCollection(c, "Broken", ["missing"]));
    assert.equal(s.collections()[0].title, "Favorites");
    s.deleteSeries(series);
    assert.deepEqual(s.collections()[0].seriesIds, []);
  } finally {
    s.close();
  }
});
test("database restart and copied backup preserve metadata and progress", () => {
  const dir = mkdtempSync(join(tmpdir(), "mangasee-"));
  let s = new Store(join(dir, "db.sqlite"));
  try {
    s.reconcile([source("a")]);
    s.saveSeries(undefined, "Persistent");
    const id = s.list({}).items[0].id;
    s.saveProgress({
      bookId: id,
      page: 3,
      cfi: null,
      completed: false,
      baseVersion: 0,
      mutationId: randomUUID(),
    });
    s.db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    s.close();
    s = new Store(join(dir, "backup.sqlite"));
    assert.equal(s.series()[0].title, "Persistent");
    assert.equal(s.progress(id).page, 3);
    assert.equal(
      (s.db.prepare("PRAGMA user_version").get() as any).user_version,
      1,
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("1,000-book catalog pagination and literal search", () => {
  const s = new Store(":memory:");
  try {
    s.reconcile(Array.from({ length: 1000 }, (_, i) => source(String(i))));
    assert.equal(s.list({ page: 4, size: 24 }).items.length, 24);
    assert.equal(s.list({ search: "%" }).total, 0);
    assert.equal(s.list({}).total, 1000);
  } finally {
    s.close();
  }
});
test("spread pairing keeps cover, wide images and offsets intact", () => {
  const pages = Array.from({ length: 8 }, (_, i) => ({
    number: i + 1,
    width: i === 4 ? 1600 : 800,
    height: 1200,
  }));
  assert.deepEqual(spreads(pages), [[1], [2, 3], [4], [5], [6, 7], [8]]);
  assert.deepEqual(spreads(pages, 1), [[1], [2], [3, 4], [5], [6, 7], [8]]);
});

test("next volume works beyond a catalog page and skips unavailable members", () => {
  const s = new Store(":memory:");
  try {
    s.reconcile(
      Array.from({ length: 260 }, (_, i) => source(String(i).padStart(3, "0"))),
    );
    const series = s.saveSeries(undefined, "Long series");
    const books = s.list({ size: 1000 }).items;
    s.assign(
      series,
      books.map((b) => b.id),
    );
    assert.equal(s.nextBook(books[250].id)?.id, books[251].id);
    s.reconcile(
      Array.from({ length: 260 }, (_, i) => ({
        ...source(String(i).padStart(3, "0")),
        available: i !== 251,
      })),
    );
    assert.equal(s.nextBook(books[250].id)?.id, books[252].id);
    assert.equal(s.nextBook(books[259].id), undefined);
  } finally {
    s.close();
  }
});
