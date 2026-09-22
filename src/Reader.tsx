import CachedImage from "./CachedImage";
import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { api, json } from "./api";
import {
  bookData,
  localProgress,
  queueProgress,
  flushProgress,
  pageUrl,
  downloads,
} from "./offline";
import {
  defaultPreferences,
  type Book,
  type Page,
  type Preferences,
  type Series,
} from "./types";
import { spreads } from "./reader-model";
const EpubReader = lazy(() => import("./epub"));
export default function Reader({
  id,
  onClose,
  onNext,
}: {
  id: string;
  onClose: () => void;
  onNext: (id: string) => void;
}) {
  const [book, setBook] = useState<Book>();
  const [pages, setPages] = useState<Page[]>([]);
  const [page, setPage] = useState(1);
  const [prefs, setPrefs] = useState<Preferences>(defaultPreferences);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [next, setNext] = useState<Book>();
  const [ready, setReady] = useState(false);
  const version = useRef(0),
    cfi = useRef<string | null>(null),
    surface = useRef<HTMLDivElement>(null),
    touch = useRef({ x: 0, y: 0, time: 0, distance: 0, zoom: 1 }),
    currentPage = useRef(1);
  useEffect(() => {
    let alive = true;
    setReady(false);
    setError("");
    setBook(undefined);
    setNext(undefined);
    setZoom(1);
    bookData(id)
      .then(async ({ book, pages }) => {
        const progress = await localProgress(book);
        let pref = defaultPreferences;
        try {
          pref =
            JSON.parse(
              localStorage.getItem(`prefs:${book.seriesId ?? "default"}`) ??
                "null",
            ) ?? defaultPreferences;
        } catch {}
        try {
          const all = await api<Series[]>("/series");
          pref = all.find((s) => s.id === book.seriesId)?.preferences ?? pref;
        } catch {
          try {
            pref =
              JSON.parse(
                localStorage.getItem(`prefs:${book.seriesId ?? "default"}`) ??
                  "null",
              ) ?? defaultPreferences;
          } catch {}
        }
        if (!alive) return;
        setBook(book);
        setPages(pages);
        setPage(Math.min(Math.max(1, progress.page), book.pages || 1));
        version.current = progress.version;
        cfi.current = progress.cfi;
        setPrefs(pref);
        setReady(true);
        if (book.seriesId) {
          void api<Book | null>(`/books/${book.id}/next`)
            .then((b) => {
              if (alive) setNext(b ?? undefined);
            })
            .catch(async () => {
              const candidates = (await downloads())
                .filter(
                  (d) =>
                    d.complete &&
                    d.book.seriesId === book.seriesId &&
                    (d.book.position ?? -1) > (book.position ?? -1),
                )
                .sort(
                  (a, b) => (a.book.position ?? 0) - (b.book.position ?? 0),
                );
              if (alive) setNext(candidates[0]?.book);
            });
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      void flushProgress();
    };
  }, [id, retry]);
  currentPage.current = page;
  function save(p: number, location: string | null = null, completed = false) {
    if (!book) return;
    void queueProgress(
      book.id,
      { page: p, cfi: location, completed },
      version.current,
    ).then(() => flushProgress());
  }
  useEffect(() => {
    if (ready && book?.format !== "EPUB")
      save(
        page,
        null,
        prefs.mode === "double"
          ? (spreads(pages, prefs.offset)
              .find((g) => g.includes(page))
              ?.includes(pages.length) ?? false)
          : page === pages.length,
      );
  }, [page, ready, prefs.mode, prefs.offset]);
  useEffect(() => {
    if (!book || !ready) return;
    localStorage.setItem(
      `prefs:${book.seriesId ?? "default"}`,
      JSON.stringify(prefs),
    );
    if (book.seriesId) {
      void api<Series[]>("/series")
        .then((all) => {
          const s = all.find((s) => s.id === book.seriesId);
          if (s)
            return api(
              `/series/${s.id}`,
              json("PATCH", { title: s.title, preferences: prefs }),
            );
        })
        .catch(() => {});
    }
  }, [prefs]);
  const groups = spreads(pages, prefs.offset),
    group = groups.find((g) => g.includes(page)) ?? [page];
  function move(delta: number) {
    if (zoom > 1) return;
    if (prefs.mode === "vertical") {
      jump(Math.max(1, Math.min(pages.length, page + delta)));
      return;
    }
    if (prefs.mode === "double") {
      const index = groups.findIndex((g) => g.includes(page));
      setPage(
        groups[Math.max(0, Math.min(groups.length - 1, index + delta))]?.[0] ??
          page,
      );
    } else setPage((p) => Math.max(1, Math.min(pages.length, p + delta)));
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,select,textarea,button"))
        return;
      if (e.key === "Escape") onClose();
      if (book?.format === "EPUB") return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        move(prefs.direction === "rtl" ? -1 : 1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(prefs.direction === "rtl" ? 1 : -1);
      }
      if (e.key === " ") {
        e.preventDefault();
        move(1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (!book || book.format === "EPUB") return;
    const images = [page + 1, page + 2, page - 1]
      .filter((n) => n > 0 && n <= pages.length)
      .map((n) => {
        const img = new Image();
        img.src = pageUrl(book, n);
        return img;
      });
    return () =>
      images.forEach((img) => {
        img.src = "";
      });
  }, [book, page, pages.length]);
  useEffect(() => {
    if (prefs.mode !== "vertical" || !surface.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible)
          setPage(Number((visible.target as HTMLElement).dataset.page));
      },
      { root: surface.current, threshold: [0.25, 0.5, 0.75] },
    );
    surface.current
      .querySelectorAll("[data-page]")
      .forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [prefs.mode, ready]);
  function jump(n: number) {
    setPage(n);
    if (prefs.mode === "vertical")
      surface.current
        ?.querySelector(`[data-page="${n}"]`)
        ?.scrollIntoView({ block: "start" });
  }
  useEffect(() => {
    if (prefs.mode === "vertical")
      surface.current
        ?.querySelector(`[data-page="${page}"]`)
        ?.scrollIntoView({ block: "start" });
  }, [prefs.mode, ready]);
  if (!book || !ready)
    return (
      <div className="reader loading">
        <button onClick={onClose}>← Library</button>
        <p>{error || "Opening your book…"}</p>
        {error && <button onClick={() => setRetry((r) => r + 1)}>Retry</button>}
      </div>
    );
  const displayed = prefs.mode === "double" ? group : [page];
  return (
    <div className="reader">
      <header className={`reader-bar ${visible ? "" : "hidden-controls"}`}>
        <button onClick={onClose}>← Library</button>
        <div>
          <strong>{book.title}</strong>
          <small>{book.volume || book.format}</small>
        </div>
        <button onClick={() => setVisible(false)} aria-label="Hide controls">
          Hide
        </button>
      </header>
      {!visible && book.format === "EPUB" && (
        <button
          className="show-controls"
          onClick={() => setVisible(true)}
          aria-label="Show reader controls"
        >
          •••
        </button>
      )}
      {book.format === "EPUB" ? (
        <Suspense fallback={<p>Loading EPUB reader…</p>}>
          <EpubReader
            book={book}
            initialCfi={cfi.current}
            initialDirection={prefs.direction}
            onProgress={(location, done) => save(1, location, done)}
          />
        </Suspense>
      ) : (
        <>
          <div
            ref={surface}
            className={`page-surface ${prefs.mode === "vertical" ? "vertical" : ""} fit-${prefs.fit}`}
            onTouchStart={(e) => {
              const t = e.touches;
              touch.current = {
                x: t[0].clientX,
                y: t[0].clientY,
                time: Date.now(),
                distance:
                  t.length === 2
                    ? Math.hypot(
                        t[0].clientX - t[1].clientX,
                        t[0].clientY - t[1].clientY,
                      )
                    : 0,
                zoom,
              };
            }}
            onTouchMove={(e) => {
              if (e.touches.length === 2 && touch.current.distance) {
                const t = e.touches;
                setZoom(
                  Math.max(
                    1,
                    Math.min(
                      4,
                      (touch.current.zoom *
                        Math.hypot(
                          t[0].clientX - t[1].clientX,
                          t[0].clientY - t[1].clientY,
                        )) /
                        touch.current.distance,
                    ),
                  ),
                );
              }
            }}
            onTouchEnd={(e) => {
              if (touch.current.distance || zoom > 1) return;
              const dx = e.changedTouches[0].clientX - touch.current.x,
                dy = e.changedTouches[0].clientY - touch.current.y;
              if (
                prefs.mode !== "vertical" &&
                Math.abs(dx) > 60 &&
                Math.abs(dx) > Math.abs(dy) &&
                Date.now() - touch.current.time < 700
              )
                move((dx < 0 ? 1 : -1) * (prefs.direction === "rtl" ? -1 : 1));
            }}
            onClick={(e) => {
              if (
                zoom > 1 ||
                (Math.abs(e.clientX - touch.current.x) > 60 &&
                  Date.now() - touch.current.time < 700)
              )
                return;
              const ratio = e.clientX / window.innerWidth;
              if (prefs.mode === "vertical" || (ratio > 0.3 && ratio < 0.7))
                setVisible((v) => !v);
              else
                move(
                  (ratio > 0.7 ? 1 : -1) * (prefs.direction === "rtl" ? -1 : 1),
                );
            }}
          >
            {prefs.mode === "vertical" ? (
              pages.map((p) => (
                <div
                  className="vertical-page"
                  data-page={p.number}
                  key={p.number}
                  style={{
                    aspectRatio: `${p.width || 800}/${p.height || 1200}`,
                    width: `${zoom * 100}%`,
                  }}
                >
                  {Math.abs(p.number - page) <= 3 && (
                    <CachedImage
                      src={pageUrl(book, p.number)}
                      alt={`Page ${p.number}`}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        if (!p.width || !p.height)
                          setPages((current) =>
                            current.map((x) =>
                              x.number === p.number
                                ? {
                                    ...x,
                                    width: img.naturalWidth,
                                    height: img.naturalHeight,
                                  }
                                : x,
                            ),
                          );
                      }}
                      onError={() =>
                        setError(
                          "Page could not load. Check your connection and retry.",
                        )
                      }
                      draggable={false}
                    />
                  )}
                </div>
              ))
            ) : (
              <div
                className="spread"
                style={{
                  flexDirection:
                    prefs.direction === "rtl" ? "row-reverse" : "row",
                  width: zoom > 1 ? `${zoom * 100}%` : undefined,
                  height: zoom > 1 ? `${zoom * 100}%` : undefined,
                }}
              >
                {displayed.map((n) => (
                  <CachedImage
                    key={`${n}-${retry}`}
                    src={pageUrl(book, n)}
                    alt={`Page ${n}`}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setPages((current) =>
                        current.map((p) =>
                          p.number === n && (!p.width || !p.height)
                            ? {
                                ...p,
                                width: img.naturalWidth,
                                height: img.naturalHeight,
                              }
                            : p,
                        ),
                      );
                    }}
                    draggable={false}
                    onError={() =>
                      setError(
                        "Page could not load. Check your connection and retry.",
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>
          {!visible && (
            <button
              className="show-controls"
              onClick={() => setVisible(true)}
              aria-label="Show reader controls"
            >
              •••
            </button>
          )}
          <footer
            className={`reader-footer ${visible ? "" : "hidden-controls"}`}
          >
            <div className="reader-options">
              <label>
                Mode
                <select
                  aria-label="Reading mode"
                  value={prefs.mode}
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      mode: e.target.value as Preferences["mode"],
                    })
                  }
                >
                  <option value="single">Single page</option>
                  <option value="double">Two pages</option>
                  <option value="vertical">Scroll</option>
                </select>
              </label>
              <label>
                Direction
                <select
                  value={prefs.direction}
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      direction: e.target.value as "rtl" | "ltr",
                    })
                  }
                >
                  <option value="rtl">Right to left</option>
                  <option value="ltr">Left to right</option>
                </select>
              </label>
              <label>
                Fit
                <select
                  value={prefs.fit}
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      fit: e.target.value as "page" | "width",
                    })
                  }
                >
                  <option value="page">Whole page</option>
                  <option value="width">Width</option>
                </select>
              </label>
              {prefs.mode === "double" && (
                <button
                  onClick={() =>
                    setPrefs({ ...prefs, offset: 1 - prefs.offset })
                  }
                >
                  Shift pairing
                </button>
              )}
              <button
                disabled={zoom >= 4}
                onClick={() => setZoom((z) => Math.min(4, z + 0.5))}
              >
                Zoom in
              </button>
              {zoom > 1 && (
                <button onClick={() => setZoom(1)}>Reset zoom</button>
              )}
            </div>
            <div className="page-navigation">
              <button onClick={() => move(-1)} disabled={page === 1}>
                Previous
              </button>
              <input
                aria-label="Page"
                type="range"
                min="1"
                max={pages.length || 1}
                value={page}
                onChange={(e) => jump(Number(e.target.value))}
              />
              <span>
                {page} / {pages.length}
              </span>
              <button
                onClick={() => move(1)}
                disabled={
                  prefs.mode === "double"
                    ? group.includes(pages.length)
                    : page === pages.length
                }
              >
                Next
              </button>
              {next && page >= pages.length - 1 && (
                <button onClick={() => onNext(next.id)}>Next volume →</button>
              )}
            </div>
          </footer>
        </>
      )}
      {error && (
        <div role="alert" className="reader-error">
          {error}
          <button
            onClick={() => {
              setError("");
              setRetry((r) => r + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
