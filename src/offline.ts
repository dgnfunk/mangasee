import { openDB } from "idb";
import { api, ApiError, json } from "./api";
import type { Book, Page, PendingProgress, Progress } from "./types";
export const CONTENT_CACHE = "mangasee-downloads-v1";
export type Download = {
  book: Book;
  pages: Page[];
  done: number;
  total: number;
  complete: boolean;
  error?: string;
  updatedAt: string;
};
const database = openDB("mangasee", 1, {
  upgrade(db) {
    db.createObjectStore("downloads", { keyPath: "book.id" });
    db.createObjectStore("pending", { keyPath: "bookId" });
    db.createObjectStore("progress", { keyPath: "bookId" });
    db.createObjectStore("meta");
  },
});
export async function putMeta(key: string, value: unknown) {
  await (await database).put("meta", value, key);
}
export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await database).get("meta", key);
}
export const pageUrl = (b: Book, page: number) =>
  `/api/books/${b.id}/page/${page}?revision=${encodeURIComponent(b.revision)}`;
export const fileUrl = (b: Book) =>
  `/api/books/${b.id}/file?revision=${encodeURIComponent(b.revision)}`;
export const coverUrl = (b: Book) =>
  `/api/books/${b.id}/cover?revision=${encodeURIComponent(b.revision)}`;
export async function downloads(): Promise<Download[]> {
  return (await database).getAll("downloads");
}
export async function downloaded(id: string): Promise<Download | undefined> {
  return (await database).get("downloads", id);
}
function urls(d: Download) {
  return d.book.format === "EPUB"
    ? [fileUrl(d.book)]
    : d.pages.map((p) => pageUrl(d.book, p.number));
}
export async function verify(d: Download) {
  const cache = await caches.open(CONTENT_CACHE);
  let done = 0;
  for (const url of urls(d)) if (await cache.match(url)) done++;
  const updated = { ...d, done, complete: done === d.total };
  await (await database).put("downloads", updated);
  return updated;
}
async function purgeDownload(id: string) {
  const d = await downloaded(id);
  if (d) {
    const cache = await caches.open(CONTENT_CACHE);
    for (const url of [...urls(d), coverUrl(d.book)]) await cache.delete(url);
  }
  await (await database).delete("downloads", id);
}
const active = new Map<string, AbortController>();
const completions = new Map<string, Promise<void>>();
export async function removeDownload(id: string) {
  active.get(id)?.abort();
  await completions.get(id);
  await purgeDownload(id);
}
export function cancelDownload(id: string) {
  active.get(id)?.abort();
}
export async function downloadBook(book: Book, onChange: () => void) {
  if (active.has(book.id)) return;
  const controller = new AbortController();
  active.set(book.id, controller);
  let finish!: () => void;
  completions.set(
    book.id,
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  let d: Download | undefined;
  try {
    if (!("caches" in window))
      throw new Error("Downloads require HTTPS or localhost.");
    await navigator.storage?.persist?.();
    book = await api<Book>(`/books/${book.id}`);
    const old = await downloaded(book.id);
    if (old && old.book.revision !== book.revision)
      await purgeDownload(book.id);
    const pages =
      book.format === "EPUB"
        ? []
        : await api<Page[]>(`/books/${book.id}/pages`);
    d = {
      book,
      pages,
      done: 0,
      total: book.format === "EPUB" ? 1 : pages.length,
      complete: false,
      updatedAt: new Date().toISOString(),
    };
    if (!d.total) throw new Error("No readable pages. Check Komga analysis.");
    await (await database).put("downloads", d);
    onChange();
    const cache = await caches.open(CONTENT_CACHE);
    for (const url of urls(d)) {
      controller.signal.throwIfAborted();
      if (!(await cache.match(url))) {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok)
          throw new Error(
            `Download failed (${response.status}). Reconnect and retry.`,
          );
        await cache.put(url, response);
      }
      d.done++;
      await (await database).put("downloads", d);
      onChange();
    }
    try {
      const cover = await fetch(coverUrl(book), { signal: controller.signal });
      if (cover.ok) await cache.put(coverUrl(book), cover);
    } catch {}
    d = await verify(d);
  } catch (e) {
    if (d) {
      d.complete = false;
      d.error = controller.signal.aborted
        ? "Paused. Keep the app open to resume."
        : e instanceof Error
          ? e.message
          : "Download failed";
      await (await database).put("downloads", d);
    } else throw e;
  } finally {
    active.delete(book.id);
    completions.delete(book.id);
    finish();
    onChange();
  }
}
export async function bookData(
  id: string,
): Promise<{ book: Book; pages: Page[] }> {
  try {
    if (!navigator.onLine) throw new Error("Offline");
    const book = await api<Book>(`/books/${id}`);
    const pages =
      book.format === "EPUB" ? [] : await api<Page[]>(`/books/${id}/pages`);
    return { book, pages };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    const d = await downloaded(id);
    if (d && (await verify(d)).complete)
      return { book: d.book, pages: d.pages };
    throw e;
  }
}
export async function localProgress(book: Book): Promise<Progress> {
  const pending = (await (await database).get("pending", book.id)) as
    | PendingProgress
    | undefined;
  const saved = (await (await database).get("progress", book.id)) as
    | Progress
    | undefined;
  if (pending)
    return {
      bookId: book.id,
      page: pending.page,
      cfi: pending.cfi,
      completed: pending.completed,
      version: pending.baseVersion,
      updatedAt: "",
    };
  if (saved && saved.version > book.progress.version) return saved;
  return book.progress;
}
// Serialize persistence and requests: a response must never delete a newer local edit.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};
export type Conflict = { pending: PendingProgress; remote: Progress };
export async function pendingConflicts(): Promise<Conflict[]> {
  return getMeta<Conflict[]>("conflicts").then((x) => x ?? []);
}
export function queueProgress(
  bookId: string,
  position: { page: number; cfi: string | null; completed: boolean },
  baseVersion: number,
) {
  return serial(async () => {
    const db = await database;
    const previous = (await db.get("pending", bookId)) as
      | PendingProgress
      | undefined;
    const saved = (await db.get("progress", bookId)) as Progress | undefined;
    const pending: PendingProgress = {
      bookId,
      ...position,
      baseVersion:
        previous?.baseVersion ?? Math.max(saved?.version ?? 0, baseVersion),
      mutationId: crypto.randomUUID(),
    };
    await db.put("pending", pending);
  });
}
let flushing: Promise<Conflict[]> | null = null;
export function flushProgress(): Promise<Conflict[]> {
  if (flushing) return flushing;
  flushing = (async () => {
    const db = await database;
    const conflicts: Conflict[] = [];
    const snapshot = await serial(
      async () => (await db.getAll("pending")) as PendingProgress[],
    );
    for (const pending of snapshot) {
      try {
        const result = await api<{ progress: Progress }>(
          `/books/${pending.bookId}/progress`,
          json("PUT", pending),
        );
        await serial(async () => {
          await db.put("progress", result.progress);
          const latest = (await db.get("pending", pending.bookId)) as
            | PendingProgress
            | undefined;
          if (latest?.mutationId === pending.mutationId)
            await db.delete("pending", pending.bookId);
          else if (latest && latest.baseVersion === pending.baseVersion)
            await db.put("pending", {
              ...latest,
              baseVersion: result.progress.version,
            });
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const latest = (await db.get("pending", pending.bookId)) as
            | PendingProgress
            | undefined;
          if (latest)
            conflicts.push({ pending: latest, remote: e.data.conflict });
        } else break;
      }
    }
    await putMeta("conflicts", conflicts);
    window.dispatchEvent(new Event("progress-synced"));
    return conflicts;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
export function resolveConflict(
  conflict: Conflict,
  choice: "local" | "remote",
) {
  return serial(async () => {
    const db = await database;
    if (choice === "remote") {
      await db.put("progress", conflict.remote);
      await db.delete("pending", conflict.pending.bookId);
    } else {
      const latest = (await db.get("pending", conflict.pending.bookId)) as
        | PendingProgress
        | undefined;
      await db.put("pending", {
        ...(latest ?? conflict.pending),
        baseVersion: conflict.remote.version,
        mutationId: crypto.randomUUID(),
      });
    }
    await putMeta(
      "conflicts",
      (await pendingConflicts()).filter(
        (c) => c.pending.bookId !== conflict.pending.bookId,
      ),
    );
  });
}
export async function clearDevice() {
  for (const c of active.values()) c.abort();
  await Promise.all(completions.values());
  await chain;
  if (flushing) await flushing;
  await caches.delete(CONTENT_CACHE);
  const db = await database;
  for (const name of ["downloads", "pending", "progress", "meta"] as const)
    await db.clear(name);
}
