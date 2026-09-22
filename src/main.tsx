import CachedImage from "./CachedImage";
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, json } from "./api";
import type { Book, Collection, Series } from "./types";
import {
  clearDevice,
  coverUrl,
  downloadBook,
  downloads,
  flushProgress,
  getMeta,
  putMeta,
  pendingConflicts,
  resolveConflict,
  cancelDownload,
  removeDownload,
  verify,
  type Conflict,
  type Download,
} from "./offline";
import Reader from "./Reader";
import "./style.css";
type View =
  | "library"
  | "reading"
  | "unorganized"
  | "series"
  | "collections"
  | "downloads"
  | "settings";
const icons: Record<View, string> = {
  library: "▦",
  reading: "◷",
  unorganized: "▤",
  series: "▥",
  collections: "◇",
  downloads: "↓",
  settings: "⚙",
};
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [storageWarning, setStorageWarning] = useState(false),
    [offline, setOffline] = useState(!navigator.onLine),
    [demo, setDemo] = useState(false);
  const [view, setView] = useState<View>("library"),
    [books, setBooks] = useState<Book[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [format, setFormat] = useState(""),
    [readStatus, setReadStatus] = useState(""),
    [series, setSeries] = useState<Series[]>([]),
    [collections, setCollections] = useState<Collection[]>([]),
    [filterSeries, setFilterSeries] = useState(""),
    [filterCollection, setFilterCollection] = useState("");
  const [reader, setReader] = useState<string | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<Book | null>(null),
    [editSeries, setEditSeries] = useState<Series | null>(null),
    [members, setMembers] = useState<Book[]>([]),
    [editCollection, setEditCollection] = useState<Collection | null>(null),
    [newKind, setNewKind] = useState<"series" | "collection" | null>(null),
    [newTitle, setNewTitle] = useState("");
  const [saved, setSaved] = useState<Download[]>([]),
    [conflicts, setConflicts] = useState<Conflict[]>([]),
    [status, setStatus] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0),
    [assignTo, setAssignTo] = useState(""),
    [storage, setStorage] = useState<StorageEstimate>({}),
    [busy, setBusy] = useState(false);
  const fail = (e: unknown) => {
    const message = e instanceof Error ? e.message : "Something went wrong";
    setError(message);
    window.dispatchEvent(new CustomEvent("app-error", { detail: message }));
  };
  async function run(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
    } catch (e) {
      fail(e);
    }
  }
  const updateDownloads = useCallback(async () => {
    try {
      setSaved(await downloads());
      setStorage((await navigator.storage?.estimate?.()) ?? {});
    } catch {
      setStorageWarning(true);
    }
  }, []);
  useEffect(() => {
    void api<{ demo: boolean }>("/session")
      .then(async (s) => {
        setDemo(s.demo);
        setAuthenticated(true);
        await putMeta("session", true).catch(() => setStorageWarning(true));
      })
      .catch(async (e) => {
        if (
          !(e instanceof ApiError) &&
          (await getMeta("session").catch(() => {
            setStorageWarning(true);
            return false;
          }))
        ) {
          setAuthenticated(true);
          setOffline(true);
        } else setAuthenticated(false);
      });
    const syncTimer = setInterval(() => {
      if (navigator.onLine)
        void flushProgress().catch(() => setStorageWarning(true));
    }, 5000);
    const online = () => {
        setOffline(false);
        void flushProgress().catch(() => setStorageWarning(true));
        setRefresh((x) => x + 1);
      },
      off = () => setOffline(true),
      progress = () => {
        void pendingConflicts()
          .then(setConflicts)
          .catch(() => setStorageWarning(true));
      };
    const resume = () => {
      if (document.visibilityState === "visible") online();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", online);
    window.addEventListener("offline", off);
    window.addEventListener("progress-synced", progress);
    void updateDownloads();
    return () => {
      clearInterval(syncTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", off);
      window.removeEventListener("progress-synced", progress);
    };
  }, []);
  useEffect(() => {
    if (!authenticated || reader) return;
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ page: String(page), size: "24" });
      if (search) query.set("search", search);
      if (format) query.set("format", format);
      if (view === "reading") query.set("status", "reading");
      else if (readStatus) query.set("status", readStatus);
      if (view === "unorganized") query.set("series", "unorganized");
      else if (filterSeries) query.set("series", filterSeries);
      if (filterCollection) query.set("collection", filterCollection);
      void Promise.all([
        api<{ items: Book[]; total: number }>(`/books?${query}`),
        api<Series[]>("/series"),
        api<Collection[]>("/collections"),
      ])
        .then(async ([b, s, c]) => {
          if (!alive) return;
          setBooks(b.items);
          setTotal(b.total);
          setSeries(s);
          setCollections(c);
          setOffline(false);
          // Optional caching must never turn a successful response into an outage.
          try {
            await putMeta("series", s);
            await putMeta("collections", c);
          } catch {
            setStorageWarning(true);
          }
        })
        .catch(async (e) => {
          if (!alive) return;
          if (e instanceof ApiError) {
            if (e.status === 401) setAuthenticated(false);
            else fail(e);
          } else {
            setOffline(true);
            try {
              setSeries((await getMeta<Series[]>("series")) ?? []);
              setCollections(
                (await getMeta<Collection[]>("collections")) ?? [],
              );
            } catch {
              setStorageWarning(true);
            }
          }
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    authenticated,
    reader,
    page,
    search,
    format,
    readStatus,
    view,
    filterSeries,
    filterCollection,
    refresh,
  ]);
  useEffect(() => {
    if (authenticated) {
      void flushProgress().catch(() => setStorageWarning(true));
      void api("/status")
        .then(setStatus)
        .catch(() => {});
    }
  }, [authenticated, refresh]);
  useEffect(() => {
    if (view === "downloads")
      void Promise.all(saved.map(verify))
        .then(() => updateDownloads())
        .catch(() => setStorageWarning(true));
  }, [view]);
  function navigate(v: View) {
    setView(v);
    setFilterSeries("");
    setFilterCollection("");
    setSelected([]);
    setPage(0);
    setSearch("");
    setReadStatus("");
  }
  async function openSeries(s: Series) {
    setEditSeries(s);
    const all: Book[] = [];
    for (let p = 0; ; p++) {
      const result = await api<{ items: Book[]; total: number }>(
        `/books?series=${s.id}&size=200&page=${p}`,
      );
      all.push(...result.items);
      if (all.length >= result.total) break;
    }
    setMembers(all);
  }
  async function reorder(index: number, delta: number) {
    const copy = [...members];
    [copy[index], copy[index + delta]] = [copy[index + delta], copy[index]];
    await api(
      `/series/${editSeries!.id}/order`,
      json("PUT", { bookIds: copy.map((b) => b.id) }),
    );
    setMembers(copy);
  }
  const title = filterSeries
    ? (series.find((s) => s.id === filterSeries)?.title ?? "Series")
    : filterCollection
      ? (collections.find((c) => c.id === filterCollection)?.title ??
        "Collection")
      : {
          library: "Your library",
          reading: "Continue reading",
          unorganized: "Unorganized",
          series: "Your series",
          collections: "Collections",
          downloads: "Available offline",
          settings: "Your reading room",
        }[view];
  if (authenticated === null)
    return (
      <div className="login">
        <div className="brand">
          Manga<span>See</span>
        </div>
        <p>Opening your reading room…</p>
      </div>
    );
  if (!authenticated)
    return (
      <main className="login">
        <div className="login-art">
          <div className="moon" />
          <div className="mountain" />
          <p>
            A little space.
            <br />A thousand stories.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/session/login", json("POST", { password }));
              await putMeta("session", true).catch(() =>
                setStorageWarning(true),
              );
              setAuthenticated(true);
              setPassword("");
              setRefresh((x) => x + 1);
            });
          }}
        >
          <div className="brand">
            Manga<span>See</span>
            <span className="brand-mark">読</span>
          </div>
          <p className="eyebrow">YOUR PERSONAL READING ROOM</p>
          <h1>
            Pick up where
            <br />
            you left off.
          </h1>
          <p className="muted">Your books. Your pace. Always a good chapter.</p>
          <label>
            Library password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" type="submit">
            Enter your library <span>→</span>
          </button>
          <small>Privately hosted. No Apple account needed.</small>
        </form>
      </main>
    );
  if (reader)
    return (
      <>
        <Reader
          key={reader}
          id={reader}
          onClose={() => {
            setReader(null);
            setRefresh((x) => x + 1);
          }}
          onNext={setReader}
        />
        {conflicts.length > 0 && (
          <ConflictDialog
            conflict={conflicts[0]}
            onResolve={(choice) =>
              void run(async () => {
                await resolveConflict(conflicts[0], choice);
                await flushProgress();
                setConflicts(await pendingConflicts());
                setReader(null);
              })
            }
          />
        )}
      </>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("library");
          }}
        >
          Manga<span>See</span>
          <span className="brand-mark">読</span>
        </a>
        <p className="eyebrow nav-heading">YOUR SPACE</p>
        <nav>
          {(["library", "reading", "unorganized"] as View[]).map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => navigate(v)}
            >
              <span aria-hidden="true">{icons[v]}</span>
              {v === "library"
                ? "Library"
                : v === "reading"
                  ? "Continue reading"
                  : "Unorganized"}
            </button>
          ))}
          <p className="eyebrow nav-heading">MADE BY YOU</p>
          {(["series", "collections", "downloads"] as View[]).map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => navigate(v)}
            >
              <span aria-hidden="true">{icons[v]}</span>
              {v === "downloads"
                ? "Downloads"
                : v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className={`connection ${offline ? "offline" : ""}`}>
            <i />
            {offline ? "Offline reading" : "Your private library"}
          </div>
          <button onClick={() => navigate("settings")}>
            ⚙ Settings & status
          </button>
          <small>One more chapter.</small>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <span className="breadcrumb">
            READING ROOM <span>/</span> {view.toUpperCase()}
          </span>
          <div>
            <span className="device-status">
              {offline ? "Offline" : demo ? "Demo library" : "Home library"}
            </span>
            <button
              className="avatar"
              onClick={() => navigate("settings")}
              aria-label="Open settings"
            >
              私
            </button>
          </div>
        </div>
        <header className="page-heading">
          <div>
            <p className="eyebrow">
              {view === "reading"
                ? "THE STORY CONTINUES"
                : "A GOOD DAY FOR A NEW CHAPTER"}
            </p>
            <h1>{title}</h1>
            <p className="muted">
              {view === "library"
                ? "All your stories, together in one quiet place."
                : view === "unorganized"
                  ? "Give your books a home. Group them into a series without moving a file."
                  : view === "downloads"
                    ? "Take a few stories with you. Keep this app open while downloading."
                    : view === "series"
                      ? "Your own order, independent of folders."
                      : view === "collections"
                        ? "Shelves for whatever you feel like reading."
                        : view === "settings"
                          ? "Private, local, and yours."
                          : "There’s more waiting on the next page."}
            </p>
          </div>
          {["library", "unorganized", "reading"].includes(view) && (
            <button
              disabled={busy || offline}
              className="secondary"
              onClick={() =>
                void run(async () => {
                  setBusy(true);
                  try {
                    const result = await api("/sync", json("POST"));
                    setNotice(`Library refreshed · ${result.count} books`);
                    setRefresh((x) => x + 1);
                  } finally {
                    setBusy(false);
                  }
                })
              }
            >
              {busy ? "Refreshing…" : "↻ Refresh library"}
            </button>
          )}
          {(view === "series" || view === "collections") && (
            <button
              className="primary"
              onClick={() => {
                setNewKind(view === "series" ? "series" : "collection");
                setNewTitle("");
              }}
            >
              + New {view === "series" ? "series" : "collection"}
            </button>
          )}
        </header>
        {error && (
          <div role="alert" className="banner error">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="banner">
            {notice}
            <button
              onClick={() => setNotice("")}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        )}
        {storageWarning && (
          <div role="alert" className="banner">
            Device storage is unavailable or full. Offline downloads and reading
            progress may not be saved. Free up device space and reopen the app.
          </div>
        )}
        {offline && view !== "downloads" && (
          <div className="banner">
            Could not load the library. Check your connection and try again.
            <button disabled={loading} onClick={() => setRefresh((x) => x + 1)}>
              Retry connection
            </button>
            <button onClick={() => navigate("downloads")}>
              Open downloads →
            </button>
          </div>
        )}
        {["library", "reading", "unorganized"].includes(view) && (
          <>
            <div className="filters">
              <label className="search">
                <span>⌕</span>
                <input
                  aria-label="Search books"
                  placeholder="Find your next chapter…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                />
              </label>
              <select
                aria-label="Format"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">All formats</option>
                {["CBZ", "CBR", "PDF", "EPUB"].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
              {view !== "reading" && (
                <select
                  aria-label="Reading status"
                  value={readStatus}
                  onChange={(e) => {
                    setReadStatus(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">All books</option>
                  <option value="unread">Unread</option>
                  <option value="reading">In progress</option>
                  <option value="completed">Completed</option>
                  <option value="unavailable">Unavailable</option>
                </select>
              )}
              <span className="book-count">{total} books</span>
            </div>
            {selected.length > 0 && (
              <div className="selection-bar">
                <strong>{selected.length} selected</strong>
                <select
                  aria-label="Assign to series"
                  value={assignTo}
                  onChange={(e) => setAssignTo(e.target.value)}
                >
                  <option value="">Choose a series</option>
                  {series.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
                <button
                  disabled={!assignTo}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/series/${assignTo}/books`,
                        json("POST", { bookIds: selected }),
                      );
                      setSelected([]);
                      setRefresh((x) => x + 1);
                    })
                  }
                >
                  Assign
                </button>
                <button
                  onClick={() => {
                    setNewKind("series");
                    setNewTitle("");
                  }}
                >
                  New series
                </button>
                <button onClick={() => setSelected([])}>Clear</button>
              </div>
            )}
            {loading ? (
              <div className="empty">Finding your books…</div>
            ) : books.length ? (
              <div className="book-grid">
                {books.map((b) => (
                  <article className="book-card" key={b.id}>
                    <div className="cover-wrap">
                      <button
                        className="cover-button"
                        disabled={!b.available}
                        onClick={() => setReader(b.id)}
                        aria-label={`Read ${b.title}`}
                      >
                        <CachedImage
                          src={coverUrl(b)}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.opacity = ".15";
                          }}
                        />
                        <span className="cover-fallback">{b.title}</span>
                      </button>
                      <label className="select-book">
                        <input
                          type="checkbox"
                          aria-label={`Select ${b.title}`}
                          checked={selected.includes(b.id)}
                          onChange={(e) =>
                            setSelected((x) =>
                              e.target.checked
                                ? [...x, b.id]
                                : x.filter((id) => id !== b.id),
                            )
                          }
                        />
                      </label>
                      <span className="format-badge">{b.format}</span>
                      {!b.available && (
                        <span className="unavailable">Unavailable</span>
                      )}
                      {b.progress.version > 0 && (
                        <div className="progress-track">
                          <div
                            style={{
                              width: `${b.progress.completed ? 100 : (100 * b.progress.page) / Math.max(1, b.pages)}%`,
                            }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="book-caption">
                      <div>
                        <h2>{b.title}</h2>
                        <p>
                          {b.volume || `${b.pages} pages`}
                          {b.progress.completed
                            ? " · Read"
                            : b.progress.version
                              ? " · In progress"
                              : ""}
                        </p>
                      </div>
                      <button
                        aria-label={`Details for ${b.title}`}
                        onClick={() => setDetail(b)}
                      >
                        •••
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">
                <span>▤</span>
                <h2>
                  {search ? "No matching stories" : "A little room for stories"}
                </h2>
                <p>
                  {search
                    ? "Try another title or filter."
                    : "Refresh your Komga library to see books here."}
                </p>
                {view === "unorganized" && (
                  <p>Organized books live in your series.</p>
                )}
              </div>
            )}
            {total > 24 && (
              <div className="pagination">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((x) => x - 1)}
                >
                  ← Previous
                </button>
                <span>
                  Page {page + 1} of {Math.ceil(total / 24)}
                </span>
                <button
                  disabled={(page + 1) * 24 >= total}
                  onClick={() => setPage((x) => x + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
        {view === "series" && (
          <div className="shelf-grid">
            {series.map((s) => (
              <article className="shelf-card" key={s.id}>
                <div className="shelf-illustration">▥</div>
                <h2>{s.title}</h2>
                <p>
                  {s.count} books ·{" "}
                  {s.preferences.direction === "rtl"
                    ? "Right to left"
                    : "Left to right"}
                </p>
                <div>
                  <button
                    onClick={() => {
                      setFilterSeries(s.id);
                      setView("library");
                    }}
                  >
                    Browse
                  </button>
                  <button onClick={() => void run(() => openSeries(s))}>
                    Organize
                  </button>
                </div>
              </article>
            ))}
            {!series.length && (
              <div className="empty">
                Create your first series, then select books in your library to
                add them.
              </div>
            )}
          </div>
        )}
        {view === "collections" && (
          <div className="shelf-grid">
            {collections.map((c) => (
              <article className="shelf-card" key={c.id}>
                <div className="shelf-illustration">◇</div>
                <h2>{c.title}</h2>
                <p>{c.seriesIds.length} series</p>
                <div>
                  <button
                    onClick={() => {
                      setFilterCollection(c.id);
                      setView("library");
                    }}
                  >
                    Browse
                  </button>
                  <button onClick={() => setEditCollection(c)}>Edit</button>
                </div>
              </article>
            ))}
            {!collections.length && (
              <div className="empty">
                Create a collection to gather your favorite series.
              </div>
            )}
          </div>
        )}
        {view === "downloads" && (
          <>
            <div className="banner">
              <span>
                {Math.round((storage.usage ?? 0) / 1048576)} MB used on this
                device · Browser storage may be cleared under storage pressure.
              </span>
              <button
                onClick={() =>
                  void run(async () => {
                    for (const d of saved) await verify(d);
                    await updateDownloads();
                  })
                }
              >
                Verify downloads
              </button>
            </div>
            <div className="download-list">
              {saved.map((d) => (
                <article key={d.book.id}>
                  <CachedImage src={coverUrl(d.book)} alt="" />
                  <div>
                    <h2>{d.book.title}</h2>
                    <p>
                      {d.complete
                        ? "Ready to read offline"
                        : `${d.done} of ${d.total} downloaded`}
                    </p>
                    {d.error && <p className="error">{d.error}</p>}
                    <progress value={d.done} max={d.total} />
                  </div>
                  <div className="download-actions">
                    <button
                      disabled={!d.complete}
                      onClick={() => setReader(d.book.id)}
                    >
                      Read
                    </button>
                    {!d.complete && (
                      <>
                        <button
                          onClick={() =>
                            void run(() =>
                              downloadBook(
                                d.book,
                                () => void updateDownloads(),
                              ),
                            )
                          }
                        >
                          Resume
                        </button>
                        <button onClick={() => cancelDownload(d.book.id)}>
                          Pause
                        </button>
                      </>
                    )}
                    <button
                      onClick={() =>
                        void run(async () => {
                          cancelDownload(d.book.id);
                          await removeDownload(d.book.id);
                          await updateDownloads();
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {!saved.length && (
              <div className="empty">
                <h2>Your traveling bookshelf</h2>
                <p>
                  Open a book’s details and choose Download to keep it on this
                  device.
                </p>
              </div>
            )}
          </>
        )}
        {view === "settings" && (
          <div className="settings-grid">
            <section className="panel">
              <h2>Library connection</h2>
              <dl>
                <dt>Mode</dt>
                <dd>
                  {status?.demo ? "Demo fixtures" : "Komga + local folders"}
                </dd>
                <dt>Library folder</dt>
                <dd>{status?.library ? "Available" : "Unavailable"}</dd>
                <dt>Komga</dt>
                <dd>{status?.komga ? "Connected" : "Unavailable"}</dd>
                <dt>Catalog</dt>
                <dd>{status?.books ?? "—"} books</dd>
                <dt>Last refresh</dt>
                <dd>
                  {status?.lastSync
                    ? new Date(status.lastSync).toLocaleString()
                    : "Not yet"}
                </dd>
              </dl>
              {status?.error && <p className="error">{status.error}</p>}
              <button
                onClick={() =>
                  void run(async () => setStatus(await api("/status")))
                }
              >
                Check connection
              </button>
            </section>
            <section className="panel">
              <h2>Make yourself at home</h2>
              <p>
                On iPad, open Safari’s Share menu, choose Add to Home Screen,
                and enable Open as Web App.
              </p>
              <p>
                Your source files stay in your library folders. Add files there,
                scan in Komga, then refresh this library.
              </p>
              <p>
                Downloads stay on this device. Keep the app open until they
                finish.
              </p>
            </section>
            <section className="panel">
              <h2>Reading progress</h2>
              <p>
                Progress syncs with this server. When devices disagree, you
                choose which position to keep.
              </p>
              <button
                onClick={() =>
                  void run(async () => {
                    await flushProgress();
                    setNotice("Checked pending reading progress.");
                  })
                }
              >
                Sync now
              </button>
            </section>
            <section className="panel">
              <h2>This device</h2>
              <p>
                Signing out clears downloaded books and local progress. Sync
                before signing out.
              </p>
              <button
                className="danger"
                onClick={() => {
                  if (
                    confirm(
                      "Sign out and remove this device’s downloads and unsynced progress?",
                    )
                  )
                    void run(async () => {
                      await api("/session/logout", json("POST"));
                      await clearDevice();
                      setAuthenticated(false);
                    });
                }}
              >
                Sign out & clear device
              </button>
            </section>
          </div>
        )}
        <footer className="library-footer">
          <span>MANGASEE</span>
          <span>A library that feels like yours.</span>
        </footer>
      </main>
      {newKind && (
        <Modal title={`New ${newKind}`} onClose={() => setNewKind(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api(
                  `/${newKind === "series" ? "series" : "collections"}`,
                  json(
                    "POST",
                    newKind === "series"
                      ? { title: newTitle }
                      : { title: newTitle, seriesIds: [] },
                  ),
                );
                if (newKind === "series" && selected.length) {
                  await api(
                    `/series/${result.id}/books`,
                    json("POST", { bookIds: selected }),
                  );
                  setSelected([]);
                }
                setNewKind(null);
                setRefresh((x) => x + 1);
              });
            }}
          >
            <label>
              Name
              <input
                autoFocus
                required
                maxLength={300}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </label>
            <button className="primary">Create {newKind}</button>
          </form>
        </Modal>
      )}
      {detail && (
        <Modal title="Book details" onClose={() => setDetail(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(
                  `/books/${detail.id}`,
                  json("PATCH", { title: detail.title, volume: detail.volume }),
                );
                setDetail(null);
                setRefresh((x) => x + 1);
              });
            }}
          >
            <label>
              Display title
              <input
                required
                value={detail.title}
                onChange={(e) =>
                  setDetail({ ...detail, title: e.target.value })
                }
              />
            </label>
            <label>
              Volume label
              <input
                value={detail.volume}
                onChange={(e) =>
                  setDetail({ ...detail, volume: e.target.value })
                }
              />
            </label>
            <p className="muted">
              {detail.format} · {detail.pages} pages ·{" "}
              {detail.available ? "Available" : "Source unavailable"}
            </p>
            <p>{detail.summary}</p>
            <button className="primary">Save details</button>
          </form>
          <div className="dialog-actions">
            <button
              disabled={!detail.available}
              onClick={() => {
                setReader(detail.id);
                setDetail(null);
              }}
            >
              Read
            </button>
            <button
              disabled={!detail.available}
              onClick={() => {
                void run(() =>
                  downloadBook(detail, () => void updateDownloads()),
                );
                setNotice(
                  "Download started. Keep this app open; see Downloads for progress.",
                );
              }}
            >
              ↓ Download
            </button>
            {detail.seriesId && (
              <button
                onClick={() =>
                  void run(async () => {
                    await api(`/books/${detail.id}/series`, json("DELETE"));
                    setDetail(null);
                    setRefresh((x) => x + 1);
                  })
                }
              >
                Remove from series
              </button>
            )}
          </div>
          {!detail.available && (
            <RelinkPicker
              onSelect={(replacement) =>
                void run(async () => {
                  await api(
                    `/books/${detail.id}/relink`,
                    json("POST", { replacementId: replacement }),
                  );
                  setDetail(null);
                  setRefresh((x) => x + 1);
                })
              }
            />
          )}
        </Modal>
      )}
      {editSeries && (
        <Modal title="Organize series" onClose={() => setEditSeries(null)}>
          <label>
            Name
            <input
              value={editSeries.title}
              onChange={(e) =>
                setEditSeries({ ...editSeries, title: e.target.value })
              }
            />
          </label>
          <button
            onClick={() =>
              void run(async () => {
                await api(
                  `/series/${editSeries.id}`,
                  json("PATCH", {
                    title: editSeries.title,
                    preferences: editSeries.preferences,
                  }),
                );
                setRefresh((x) => x + 1);
                setNotice("Series saved.");
              })
            }
          >
            Save name
          </button>
          <ol className="order-list">
            {members.map((b, i) => (
              <li key={b.id}>
                <span>{b.title}</span>
                <button
                  aria-label={`Move ${b.title} up`}
                  disabled={i === 0}
                  onClick={() => void run(() => reorder(i, -1))}
                >
                  ↑
                </button>
                <button
                  aria-label={`Move ${b.title} down`}
                  disabled={i === members.length - 1}
                  onClick={() => void run(() => reorder(i, 1))}
                >
                  ↓
                </button>
                <button
                  aria-label={`Remove ${b.title} from series`}
                  onClick={() =>
                    void run(async () => {
                      await api(`/books/${b.id}/series`, json("DELETE"));
                      setMembers((m) => m.filter((x) => x.id !== b.id));
                      setRefresh((x) => x + 1);
                    })
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
          <button
            className="danger"
            onClick={() => {
              if (
                confirm(
                  "Delete this virtual series? Books and progress will be kept.",
                )
              )
                void run(async () => {
                  await api(`/series/${editSeries.id}`, json("DELETE"));
                  setEditSeries(null);
                  setRefresh((x) => x + 1);
                });
            }}
          >
            Delete series
          </button>
        </Modal>
      )}
      {editCollection && (
        <Modal title="Edit collection" onClose={() => setEditCollection(null)}>
          <label>
            Name
            <input
              value={editCollection.title}
              onChange={(e) =>
                setEditCollection({ ...editCollection, title: e.target.value })
              }
            />
          </label>
          <div className="collection-checks">
            {series.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={editCollection.seriesIds.includes(s.id)}
                  onChange={(e) =>
                    setEditCollection({
                      ...editCollection,
                      seriesIds: e.target.checked
                        ? [...editCollection.seriesIds, s.id]
                        : editCollection.seriesIds.filter((id) => id !== s.id),
                    })
                  }
                />
                {s.title}
              </label>
            ))}
          </div>
          <div className="dialog-actions">
            <button
              className="primary"
              onClick={() =>
                void run(async () => {
                  await api(
                    `/collections/${editCollection.id}`,
                    json("PUT", {
                      title: editCollection.title,
                      seriesIds: editCollection.seriesIds,
                    }),
                  );
                  setEditCollection(null);
                  setRefresh((x) => x + 1);
                })
              }
            >
              Save collection
            </button>
            <button
              className="danger"
              onClick={() => {
                if (
                  confirm("Delete this collection? Your series will be kept.")
                )
                  void run(async () => {
                    await api(
                      `/collections/${editCollection.id}`,
                      json("DELETE"),
                    );
                    setEditCollection(null);
                    setRefresh((x) => x + 1);
                  });
              }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
      {conflicts.length > 0 && (
        <ConflictDialog
          conflict={conflicts[0]}
          onResolve={(choice) =>
            void run(async () => {
              await resolveConflict(conflicts[0], choice);
              await flushProgress();
              setConflicts(await pendingConflicts());
              setRefresh((x) => x + 1);
            })
          }
        />
      )}
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
  dismissible = true,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  dismissible?: boolean;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const [dialogError, setDialogError] = useState("");
  useEffect(() => {
    const onError = (e: Event) =>
      setDialogError((e as CustomEvent<string>).detail);
    window.addEventListener("app-error", onError);
    return () => window.removeEventListener("app-error", onError);
  }, []);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        if (dismissible) onClose();
        else e.preventDefault();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        {dismissible && (
          <button onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        )}
      </header>
      {dialogError && (
        <p role="alert" className="error">
          {dialogError}
        </p>
      )}
      {children}
    </dialog>
  );
}
function RelinkPicker({ onSelect }: { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState(""),
    [options, setOptions] = useState<Book[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void api<{ items: Book[] }>(
        `/books?series=unorganized&status=unread&size=100&search=${encodeURIComponent(query)}`,
      )
        .then((r) => {
          if (alive) setOptions(r.items.filter((b) => b.available));
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  return (
    <section>
      <label>
        Find replacement
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search unorganized, unread books"
        />
      </label>
      {error && <p className="error">{error}</p>}
      <label>
        Replacement book
        <select
          value=""
          onChange={(e) => {
            if (
              e.target.value &&
              confirm(
                "Relink this source and keep your organization and progress?",
              )
            )
              onSelect(e.target.value);
          }}
        >
          <option value="">Choose a replacement</option>
          {options.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
      </label>
      <small>
        Search narrows the first 100 matches. Only available, unorganized books
        without reading history can replace a missing source.
      </small>
    </section>
  );
}
function ConflictDialog({
  conflict,
  onResolve,
}: {
  conflict: Conflict;
  onResolve: (choice: "local" | "remote") => void;
}) {
  return (
    <Modal
      title="Choose your reading position"
      onClose={() => {}}
      dismissible={false}
    >
      <p>
        This book was read on another device. Which position should we keep?
      </p>
      <div className="conflict-options">
        <button onClick={() => onResolve("local")}>
          This device ·{" "}
          {conflict.pending.cfi
            ? "EPUB location"
            : `page ${conflict.pending.page}`}
        </button>
        <button onClick={() => onResolve("remote")}>
          Server ·{" "}
          {conflict.remote.cfi
            ? "EPUB location"
            : `page ${conflict.remote.page}`}
          <small>{new Date(conflict.remote.updatedAt).toLocaleString()}</small>
        </button>
      </div>
    </Modal>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
