import { useEffect, useRef, useState } from "react";
import ePub from "epubjs";
import type { Book } from "./types";
import { fileUrl, CONTENT_CACHE } from "./offline";
export default function EpubReader({
  book,
  initialCfi,
  initialDirection,
  onProgress,
}: {
  book: Book;
  initialCfi: string | null;
  initialDirection: "rtl" | "ltr";
  onProgress: (cfi: string, completed: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    rendition = useRef<any>(null),
    callback = useRef(onProgress);
  callback.current = onProgress;
  const [toc, setToc] = useState<{ label: string; href: string }[]>([]),
    [error, setError] = useState(""),
    [font, setFont] = useState(110),
    [theme, setTheme] = useState("paper"),
    [direction, setDirection] = useState(initialDirection);
  useEffect(() => {
    let stopped = false;
    let publication: any;
    const controller = new AbortController();
    async function load() {
      try {
        const cached =
          "caches" in window
            ? await (await caches.open(CONTENT_CACHE)).match(fileUrl(book))
            : undefined;
        const response =
          cached ?? (await fetch(fileUrl(book), { signal: controller.signal }));
        if (!response.ok)
          throw new Error(`Unable to load EPUB (${response.status})`);
        const data = await response.arrayBuffer();
        if (stopped) return;
        publication = ePub(data);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            publication.opened.then(() => publication.ready),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("EPUB parsing timed out")),
                30000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (stopped) {
          publication.destroy();
          return;
        }
        publication.spine.hooks.content.register((doc: Document) => {
          doc
            .querySelectorAll(
              "script,iframe,object,embed,form,meta[http-equiv]",
            )
            .forEach((el) => el.remove());
          doc.querySelectorAll("*").forEach((el) => {
            for (const attr of [...el.attributes]) {
              if (attr.name.toLowerCase().startsWith("on"))
                el.removeAttribute(attr.name);
              if (
                [
                  "src",
                  "href",
                  "xlink:href",
                  "poster",
                  "action",
                  "srcset",
                ].includes(attr.name.toLowerCase()) &&
                /(?:https?:|\/\/|javascript:)/i.test(attr.value)
              )
                el.removeAttribute(attr.name);
            }
          });
        });
        const view = publication.renderTo(host.current!, {
          width: "100%",
          height: "100%",
          allowScriptedContent: false,
          allowPopups: false,
          flow: "paginated",
          spread: "auto",
        });
        rendition.current = view;
        view.themes.register("paper", {
          body: { color: "#252821", background: "#f4f0e6" },
        });
        view.themes.register("night", {
          body: { color: "#eee9dc", background: "#1a211d" },
        });
        view.themes.select("paper");
        view.themes.fontSize("110%");
        view.direction(initialDirection);
        view.on("relocated", (location: any) => {
          if (location.start?.cfi)
            callback.current(location.start.cfi, !!location.atEnd);
        });
        const navigation = await publication.loaded.navigation;
        const flatten = (items: any[]): { label: string; href: string }[] =>
          items.flatMap((x) => [
            { label: x.label.trim(), href: x.href },
            ...flatten(x.subitems ?? []),
          ]);
        setToc(flatten(navigation.toc));
        await view.display(initialCfi ?? undefined);
      } catch (e) {
        if (!stopped)
          setError(
            "This EPUB could not be opened. Check that it is a valid, DRM-free EPUB. " +
              (e instanceof Error ? e.message : ""),
          );
      }
    }
    void load();
    return () => {
      stopped = true;
      controller.abort();
      rendition.current?.destroy();
      rendition.current = null;
      publication?.destroy();
    };
  }, [book.id]);
  return (
    <section className="epub-reader">
      <div className="epub-toolbar">
        <label>
          Contents
          <select
            aria-label="Table of contents"
            onChange={(e) => void rendition.current?.display(e.target.value)}
          >
            <option value="">Choose chapter</option>
            {toc.map((t, i) => (
              <option key={i} value={t.href}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Text size
          <input
            type="range"
            min="80"
            max="200"
            value={font}
            onChange={(e) => {
              setFont(+e.target.value);
              rendition.current?.themes.fontSize(e.target.value + "%");
            }}
          />
        </label>
        <select
          aria-label="EPUB theme"
          value={theme}
          onChange={(e) => {
            setTheme(e.target.value);
            rendition.current?.themes.select(e.target.value);
          }}
        >
          <option value="paper">Paper</option>
          <option value="night">Night</option>
        </select>
        <select
          aria-label="EPUB direction"
          value={direction}
          onChange={(e) => {
            setDirection(e.target.value as "rtl" | "ltr");
            rendition.current?.direction(e.target.value);
          }}
        >
          <option value="rtl">Right to left</option>
          <option value="ltr">Left to right</option>
        </select>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <div className="epub-host" ref={host} />
      )}
      <div className="epub-controls">
        <button onClick={() => void rendition.current?.prev()}>Previous</button>
        <button onClick={() => void rendition.current?.next()}>Next</button>
      </div>
    </section>
  );
}
