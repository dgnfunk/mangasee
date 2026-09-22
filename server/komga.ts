import type { Format, Page, SourceBook } from "../src/types.js";
export interface CatalogSource {
  catalog(): Promise<SourceBook[]>;
  pages(id: string): Promise<Page[]>;
  content(
    id: string,
    kind: "cover" | "file" | "page",
    page?: number,
  ): Promise<Response>;
  health(): Promise<boolean>;
}
export class Komga implements CatalogSource {
  constructor(
    private url: string,
    private key: string,
  ) {}
  async request(path: string, init: RequestInit = {}) {
    const r = await fetch(`${this.url.replace(/\/$/, "")}/api/v1${path}`, {
      ...init,
      headers: {
        "X-API-Key": this.key,
        Accept: "application/json",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(
        `Komga returned ${r.status}; check connectivity, API permissions, and book analysis.`,
      );
    }
    return r;
  }
  async health() {
    try {
      const response = await this.request("/libraries");
      await response.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }
  async catalog() {
    const result: SourceBook[] = [];
    let expected: number | undefined;
    for (let page = 0; page < 10000; page++) {
      const data = (await (
        await this.request(`/books/list?page=${page}&size=200&sort=id,asc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).json()) as any;
      if (
        !Array.isArray(data.content) ||
        typeof data.totalElements !== "number" ||
        typeof data.last !== "boolean"
      )
        throw new Error("Invalid Komga catalog response");
      if (expected === undefined) expected = data.totalElements;
      if (expected !== data.totalElements)
        throw new Error("Komga catalog changed during refresh; retry.");
      for (const b of data.content) {
        if (typeof b.id !== "string" || !b.media || !b.metadata)
          throw new Error("Incomplete Komga book");
        const extension = (b.url ?? b.name ?? "")
          .split(".")
          .pop()
          ?.toUpperCase();
        let format: Format = ["CBZ", "CBR", "PDF", "EPUB"].includes(extension)
          ? extension
          : b.media.mediaType?.includes("pdf")
            ? "PDF"
            : b.media.mediaType?.includes("epub")
              ? "EPUB"
              : b.media.mediaType?.includes("zip")
                ? "CBZ"
                : b.media.mediaType?.includes("rar")
                  ? "CBR"
                  : "OTHER";
        result.push({
          komgaId: b.id,
          title: b.metadata.title || b.name,
          format,
          pages: b.media.pagesCount ?? 0,
          available: !b.deleted && b.media.status === "READY",
          revision: b.fileHash || b.fileLastModified || b.lastModified,
          summary: b.metadata.summary || "",
        });
      }
      if (data.last) {
        if (result.length !== expected)
          throw new Error("Incomplete catalog; previous catalog preserved");
        return result;
      }
    }
    throw new Error("Catalog exceeds pagination limit");
  }
  async pages(id: string) {
    const data = (await (
      await this.request(`/books/${encodeURIComponent(id)}/pages`)
    ).json()) as any[];
    if (!Array.isArray(data)) throw new Error("Invalid page manifest");
    return data.map((p, i) => ({
      number: p.number ?? i + 1,
      width: p.width ?? 0,
      height: p.height ?? 0,
    }));
  }
  content(id: string, kind: "cover" | "file" | "page", page?: number) {
    const suffix =
      kind === "cover"
        ? "thumbnail"
        : kind === "file"
          ? "file"
          : `pages/${page}?convert=jpeg&zero_based=false`;
    return this.request(`/books/${encodeURIComponent(id)}/${suffix}`, {
      signal: AbortSignal.timeout(300000),
      headers: {
        Accept: kind === "file" ? "application/octet-stream" : "image/jpeg",
      },
    });
  }
}
export class DemoSource implements CatalogSource {
  count: number;
  constructor(count = 12) {
    this.count = count;
  }
  async health() {
    return true;
  }
  async catalog(): Promise<SourceBook[]> {
    const names = [
      "The Quiet Mountain",
      "Paper Lanterns",
      "Beyond the Rain",
      "A Small Journey",
      "Moonlit Station",
      "The Last Garden",
    ];
    return Array.from({ length: this.count }, (_, i) => ({
      komgaId: `demo-${i}`,
      title: `${names[i % names.length]} · ${String(Math.floor(i / names.length) + 1).padStart(2, "0")}`,
      format: (["CBZ", "CBR", "PDF"] as Format[])[i % 3],
      pages: 12,
      available: true,
      revision: "demo-v1",
      summary:
        "An original generated fixture for testing MangaSee. Connect your Komga library to read your own books.",
    }));
  }
  async pages() {
    return Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      width: i === 4 ? 1600 : 800,
      height: 1200,
    }));
  }
  async content(id: string, kind: "cover" | "file" | "page", page = 1) {
    if (kind === "file")
      throw new Error(
        "Demo fixtures do not contain downloadable source archives",
      );
    const n = Number(id.split("-")[1]) || 0;
    const colors = [
      "#adc2aa",
      "#bda987",
      "#98aeb7",
      "#be978c",
      "#aaa0bf",
      "#bdbe96",
    ];
    const wide = kind === "page" && page === 5;
    const width = wide ? 1600 : 800;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1200" viewBox="0 0 ${width} 1200"><rect width="100%" height="100%" fill="${colors[n % 6]}"/><circle cx="600" cy="290" r="220" fill="#ece6d5" opacity=".8"/><path d="M0 960L300 400 530 760 760 270 1600 1080V1200H0Z" fill="#253c35"/><path d="M0 1040L300 730 600 1070 900 700 1600 1200H0Z" fill="#142b27"/><path d="M0 1200Q350 750 800 1200" fill="#f5e9d2" opacity=".6"/><text x="60" y="100" fill="#20362f" font-family="Georgia" font-size="32" letter-spacing="8">MANGASEE / DEMO</text><text x="60" y="1070" fill="#f5eedb" font-family="Georgia" font-size="58">${kind === "cover" ? "Reading room" : `Page ${page}`}</text><text x="60" y="1130" fill="#f5eedb" font-family="sans-serif" font-size="22">Original test artwork · Volume ${n + 1}</text></svg>`;
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
  }
}
