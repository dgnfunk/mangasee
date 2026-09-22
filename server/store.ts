import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  defaultPreferences,
  type Book,
  type Collection,
  type Preferences,
  type Progress,
  type SourceBook,
  type Series,
  type PendingProgress,
} from "../src/types.js";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 1)
      throw new Error(
        "Database is newer than this application. Restore a compatible backup before rollback.",
      );
    if (version === 0)
      this.db.exec(`BEGIN;
      CREATE TABLE books(id TEXT PRIMARY KEY, komga_id TEXT UNIQUE NOT NULL, source_title TEXT NOT NULL, title TEXT, volume TEXT NOT NULL DEFAULT '', format TEXT NOT NULL, pages INTEGER NOT NULL, available INTEGER NOT NULL, revision TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE series(id TEXT PRIMARY KEY, title TEXT NOT NULL, preferences TEXT NOT NULL);
      CREATE TABLE memberships(book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE, position INTEGER NOT NULL);
      CREATE INDEX memberships_series ON memberships(series_id, position);
      CREATE TABLE collections(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE collection_series(collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE, series_id TEXT REFERENCES series(id) ON DELETE CASCADE, PRIMARY KEY(collection_id,series_id));
      CREATE TABLE progress(book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE, page INTEGER NOT NULL, cfi TEXT, completed INTEGER NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE mutations(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE sessions(token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  getState(key: string) {
    return (
      this.db.prepare("SELECT value FROM state WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  setState(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO state VALUES(?,?)").run(key, value);
  }
  reconcile(items: SourceBook[]) {
    if (new Set(items.map((x) => x.komgaId)).size !== items.length)
      throw new Error("Duplicate source identifiers; catalog was not changed.");
    this.transaction(() => {
      this.db.exec("UPDATE books SET available=0");
      const stmt = this.db.prepare(
        `INSERT INTO books(id,komga_id,source_title,format,pages,available,revision,summary) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(komga_id) DO UPDATE SET source_title=excluded.source_title,format=excluded.format,pages=excluded.pages,available=excluded.available,revision=excluded.revision,summary=excluded.summary`,
      );
      for (const b of items)
        stmt.run(
          randomUUID(),
          b.komgaId,
          b.title,
          b.format,
          b.pages,
          +b.available,
          b.revision,
          b.summary,
        );
      this.setState("lastSync", new Date().toISOString());
    });
  }
  progress(id: string): Progress {
    const p = this.db
      .prepare("SELECT * FROM progress WHERE book_id=?")
      .get(id) as any;
    return p
      ? {
          bookId: id,
          page: p.page,
          cfi: p.cfi,
          completed: !!p.completed,
          version: p.version,
          updatedAt: p.updated_at,
        }
      : {
          bookId: id,
          page: 1,
          cfi: null,
          completed: false,
          version: 0,
          updatedAt: "",
        };
  }
  book(id: string): Book | undefined {
    const row = this.db
      .prepare(
        `SELECT b.*,m.series_id,m.position FROM books b LEFT JOIN memberships m ON m.book_id=b.id WHERE b.id=?`,
      )
      .get(id) as any;
    return row && this.mapBook(row);
  }
  private mapBook(b: any): Book {
    return {
      id: b.id,
      komgaId: b.komga_id,
      title: b.title ?? b.source_title,
      sourceTitle: b.source_title,
      volume: b.volume,
      format: b.format,
      pages: b.pages,
      available: !!b.available,
      revision: b.revision,
      summary: b.summary,
      seriesId: b.series_id ?? null,
      position: b.position ?? null,
      progress: this.progress(b.id),
    };
  }
  list(q: {
    search?: string;
    format?: string;
    status?: string;
    series?: string;
    collection?: string;
    page?: number;
    size?: number;
  }) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.search) {
      where.push(
        `(COALESCE(b.title,b.source_title) LIKE ? ESCAPE '\\' OR b.volume LIKE ? ESCAPE '\\')`,
      );
      const s = "%" + q.search.replace(/[\\%_]/g, "\\$&") + "%";
      params.push(s, s);
    }
    if (q.format) {
      where.push("b.format=?");
      params.push(q.format);
    }
    if (q.series === "unorganized") where.push("m.series_id IS NULL");
    else if (q.series) {
      where.push("m.series_id=?");
      params.push(q.series);
    }
    if (q.collection) {
      where.push(
        "m.series_id IN (SELECT series_id FROM collection_series WHERE collection_id=?)",
      );
      params.push(q.collection);
    }
    if (q.status === "reading") where.push("p.version>0 AND p.completed=0");
    if (q.status === "unread") where.push("p.book_id IS NULL");
    if (q.status === "completed") where.push("p.completed=1");
    if (q.status === "unavailable") where.push("b.available=0");
    const from = `FROM books b LEFT JOIN memberships m ON m.book_id=b.id LEFT JOIN progress p ON p.book_id=b.id ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
    const total = (
      this.db.prepare("SELECT COUNT(*) AS n " + from).get(...params) as any
    ).n;
    const size = q.size ?? 36;
    const page = q.page ?? 0;
    const rows = this.db
      .prepare(
        `SELECT b.*,m.series_id,m.position ${from} ORDER BY ${q.series && q.series !== "unorganized" ? "m.position," : q.status === "reading" ? "p.updated_at DESC," : ""} COALESCE(b.title,b.source_title) COLLATE NOCASE,b.id LIMIT ? OFFSET ?`,
      )
      .all(...params, size, page * size);
    return { items: rows.map((x) => this.mapBook(x)), total, page, size };
  }
  nextBook(id: string): Book | undefined {
    const row = this.db
      .prepare(
        `SELECT b.*,m.series_id,m.position FROM memberships m JOIN books b ON b.id=m.book_id WHERE m.series_id=(SELECT series_id FROM memberships WHERE book_id=?) AND m.position>(SELECT position FROM memberships WHERE book_id=?) AND b.available=1 ORDER BY m.position LIMIT 1`,
      )
      .get(id, id);
    return row ? this.mapBook(row) : undefined;
  }
  editBook(id: string, v: { title?: string; volume?: string }) {
    if (!this.book(id)) throw new Error("Book not found");
    if (v.title !== undefined)
      this.db.prepare("UPDATE books SET title=? WHERE id=?").run(v.title, id);
    if (v.volume !== undefined)
      this.db.prepare("UPDATE books SET volume=? WHERE id=?").run(v.volume, id);
    return this.book(id);
  }
  series(): Series[] {
    return this.db
      .prepare(
        "SELECT s.*,COUNT(m.book_id) AS count FROM series s LEFT JOIN memberships m ON m.series_id=s.id GROUP BY s.id ORDER BY s.title COLLATE NOCASE",
      )
      .all()
      .map((s: any) => ({ ...s, preferences: JSON.parse(s.preferences) }));
  }
  saveSeries(id: string | undefined, title: string, preferences?: Preferences) {
    const key = id ?? randomUUID();
    if (id && !this.series().some((s) => s.id === id))
      throw new Error("Series not found");
    this.db
      .prepare(
        "INSERT INTO series VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,preferences=excluded.preferences",
      )
      .run(
        key,
        title,
        JSON.stringify(
          preferences ??
            this.series().find((s) => s.id === key)?.preferences ??
            defaultPreferences,
        ),
      );
    return key;
  }
  deleteSeries(id: string) {
    this.db.prepare("DELETE FROM series WHERE id=?").run(id);
  }
  assign(seriesId: string, bookIds: string[]) {
    this.transaction(() => {
      if (!this.series().some((s) => s.id === seriesId))
        throw new Error("Series not found");
      let position =
        (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(position),-1) AS n FROM memberships WHERE series_id=?",
            )
            .get(seriesId) as any
        ).n + 1;
      for (const id of bookIds) {
        if (!this.book(id)) throw new Error("Book not found");
        this.db
          .prepare(
            "INSERT INTO memberships VALUES(?,?,?) ON CONFLICT(book_id) DO UPDATE SET series_id=excluded.series_id,position=excluded.position",
          )
          .run(id, seriesId, position++);
      }
    });
  }
  reorder(seriesId: string, ids: string[]) {
    this.transaction(() => {
      const current = this.db
        .prepare("SELECT book_id FROM memberships WHERE series_id=?")
        .all(seriesId)
        .map((x: any) => x.book_id);
      if (
        current.length !== ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !current.includes(id))
      )
        throw new Error("Ordering must include every member exactly once");
      ids.forEach((id, i) =>
        this.db
          .prepare("UPDATE memberships SET position=? WHERE book_id=?")
          .run(i, id),
      );
    });
  }
  unassign(id: string) {
    this.db.prepare("DELETE FROM memberships WHERE book_id=?").run(id);
  }
  collections(): Collection[] {
    return this.db
      .prepare("SELECT * FROM collections ORDER BY title")
      .all()
      .map((c: any) => ({
        ...c,
        seriesIds: this.db
          .prepare(
            "SELECT series_id FROM collection_series WHERE collection_id=?",
          )
          .all(c.id)
          .map((s: any) => s.series_id),
      }));
  }
  saveCollection(id: string | undefined, title: string, ids: string[]) {
    return this.transaction(() => {
      const key = id ?? randomUUID();
      this.db
        .prepare(
          "INSERT INTO collections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title",
        )
        .run(key, title);
      this.db
        .prepare("DELETE FROM collection_series WHERE collection_id=?")
        .run(key);
      for (const s of new Set(ids))
        this.db
          .prepare("INSERT INTO collection_series VALUES(?,?)")
          .run(key, s);
      return key;
    });
  }
  deleteCollection(id: string) {
    this.db.prepare("DELETE FROM collections WHERE id=?").run(id);
  }
  relink(id: string, replacement: string) {
    this.transaction(() => {
      const old = this.book(id),
        next = this.book(replacement);
      if (
        !old ||
        !next ||
        old.available ||
        !next.available ||
        id === replacement
      )
        throw new Error(
          "Choose an unavailable book and an available replacement",
        );
      if (next.seriesId || next.progress.version)
        throw new Error(
          "Replacement is organized or has reading progress. Choose an unorganized replacement without reading history.",
        );
      this.db.prepare("DELETE FROM books WHERE id=?").run(replacement);
      this.db
        .prepare(
          "UPDATE books SET komga_id=?,source_title=?,format=?,pages=?,available=1,revision=?,summary=? WHERE id=?",
        )
        .run(
          next.komgaId,
          next.sourceTitle,
          next.format,
          next.pages,
          next.revision,
          next.summary,
          id,
        );
    });
  }
  saveProgress(p: PendingProgress): {
    conflict?: Progress;
    progress?: Progress;
  } {
    return this.transaction(() => {
      const prior = this.db
        .prepare("SELECT result,book_id FROM mutations WHERE id=?")
        .get(p.mutationId) as any;
      if (prior) {
        if (prior.book_id !== p.bookId)
          throw new Error("Mutation belongs to a different book");
        return { progress: JSON.parse(prior.result) };
      }
      const book = this.book(p.bookId);
      if (!book) throw new Error("Book not found");
      const current = this.progress(p.bookId);
      if (current.version !== p.baseVersion) return { conflict: current };
      if (
        book.format !== "EPUB" &&
        (p.page < 1 || p.page > Math.max(1, book.pages))
      )
        throw new Error("Page is outside this book");
      const progress: Progress = {
        bookId: p.bookId,
        page: p.page,
        cfi: p.cfi,
        completed: p.completed,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          "INSERT INTO progress VALUES(?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET page=excluded.page,cfi=excluded.cfi,completed=excluded.completed,version=excluded.version,updated_at=excluded.updated_at",
        )
        .run(
          p.bookId,
          p.page,
          p.cfi,
          +p.completed,
          progress.version,
          progress.updatedAt,
        );
      this.db
        .prepare("INSERT INTO mutations VALUES(?,?,?)")
        .run(p.mutationId, p.bookId, JSON.stringify(progress));
      return { progress };
    });
  }
  close() {
    this.db.close();
  }
}
