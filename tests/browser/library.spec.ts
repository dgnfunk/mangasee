import { test, expect, type Page } from "@playwright/test";
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Library password").fill("mangasee-test-password");
  await page.getByRole("button", { name: "Enter your library" }).click();
  await expect(
    page.getByRole("heading", { name: "Your library", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".book-card")).toHaveCount(12);
  await page.request.post("/api/testing/reset", {
    headers: { origin: "http://127.0.0.1:4173" },
  });
  await page.reload();
  await expect(page.locator(".book-card")).toHaveCount(12);
}
test("organize a series, reorder books, read and resume", async ({ page }) => {
  await login(page);
  await page.getByRole("checkbox").nth(0).check();
  await page.getByRole("checkbox").nth(1).check();
  await page.getByRole("button", { name: "New series", exact: true }).click();
  const seriesName = "My test series " + Date.now();
  await page.getByRole("dialog").getByLabel("Name").fill(seriesName);
  await page.getByRole("button", { name: "Create series" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Series", exact: true }).click();
  const card = page.locator(".shelf-card").filter({ hasText: seriesName });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Organize" }).click();
  await expect(page.locator(".order-list li")).toHaveCount(2);
  const first = await page.locator(".order-list li span").first().textContent();
  await page
    .getByRole("button", { name: /Move .* down/ })
    .first()
    .click();
  await expect(page.locator(".order-list li span").last()).toHaveText(first!);
  await page.getByLabel("Close dialog").click();
  await card.getByRole("button", { name: "Browse", exact: true }).click();
  await page.locator(".cover-button").first().click();
  await expect(page.getByLabel("Reading mode")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Page", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "Library", exact: false }).click();
  await page.locator(".cover-button").first().click();
  await expect(page.getByLabel("Page", { exact: true })).toHaveValue("2");
});
test("download, read offline, detect evicted pages, and recover", async ({
  page,
  context,
  browserName,
}) => {
  await login(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.locator(".book-card")).toHaveCount(12);
  await page
    .getByRole("button", { name: /Details for/ })
    .first()
    .click();
  await page.getByRole("button", { name: "↓ Download", exact: true }).click();
  await page.getByLabel("Close dialog").click();
  await page.getByRole("button", { name: "Downloads", exact: true }).click();
  await expect(
    page.getByText("Ready to read offline", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  if (browserName === "webkit") {
    // WebKit's offline emulation rejects even blob: URLs. Simulate an HTTP outage
    // here; cold navigation is a separate, explicitly unresolved acceptance test.
    await context.route(/^https?:/, (route) =>
      route.abort("internetdisconnected"),
    );
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event("offline"));
    });
  } else await context.setOffline(true);
  await page.getByRole("button", { name: "Downloads", exact: true }).click();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Page 1", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "Page 1", exact: true })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Page", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "Library", exact: false }).click();
  await page.getByRole("button", { name: "Downloads", exact: true }).click();
  await page.evaluate(async () => {
    const cache = await caches.open("mangasee-downloads-v1");
    const keys = await cache.keys();
    const page = keys.find((k) => k.url.includes("/page/1?"));
    if (page) await cache.delete(page);
  });
  await page.getByRole("button", { name: "Verify downloads" }).click();
  await expect(
    page.getByRole("button", { name: "Read", exact: true }),
  ).toBeDisabled();
  if (browserName === "webkit") {
    await context.unroute(/^https?:/);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => true,
      });
      window.dispatchEvent(new Event("online"));
    });
  } else await context.setOffline(false);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByText("Ready to read offline", { exact: true }),
  ).toBeVisible();
});
test("renders without horizontal overflow and exposes useful keyboard focus", async ({
  page,
  browserName,
}) => {
  await login(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `output/playwright/library-${browserName}.png`,
    fullPage: true,
  });
  await page.getByLabel("Search books").fill("Quiet");
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.getByLabel("Format", { exact: true }).selectOption("PDF");
  await expect(page.locator(".book-card")).toHaveCount(0);
});

test("EPUB renders, changes chapters, and blocks remote resources and scripts", async ({
  page,
}) => {
  await login(page);
  const outbound: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("blocked.example")) outbound.push(request.url());
  });
  await page.evaluate(() => {
    (window as any).epubScriptRan = false;
    window.addEventListener("message", (e) => {
      if (e.data === "epub-script-ran") (window as any).epubScriptRan = true;
    });
  });
  await page
    .getByRole("button", { name: "Read Reflow EPUB", exact: true })
    .click();
  await expect(page.getByLabel("Table of contents")).toBeVisible();
  await expect(page.locator(".epub-host iframe")).toHaveCount(1);
  await page.getByLabel("Table of contents").selectOption("one.xhtml");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector<HTMLIFrameElement>(".epub-host iframe")
            ?.contentDocument?.querySelector("h1")?.textContent,
      ),
    )
    .toBe("Chapter one");
  await page.getByLabel("Table of contents").selectOption("two.xhtml");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector<HTMLIFrameElement>(".epub-host iframe")
            ?.contentDocument?.querySelector("h1")?.textContent,
      ),
    )
    .toBe("Chapter two");
  expect(await page.evaluate(() => (window as any).epubScriptRan)).toBe(false);
  expect(outbound).toEqual([]);
  await page.getByRole("button", { name: "Library", exact: false }).click();
  await page
    .getByRole("button", { name: "Read Fixed EPUB", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector<HTMLIFrameElement>(".epub-host iframe")
            ?.contentDocument?.querySelector("h1")?.textContent,
      ),
    )
    .toBe("Chapter one");
});

test("cold launch from the app shell without a network", async ({
  page,
  context,
  browserName,
}) => {
  test.fixme(
    browserName === "webkit",
    "WebKit 26.6 automation returns an internal error on offline navigation despite an active worker. Actual iPad cold-launch gate remains open.",
  );
  await login(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page
    .getByRole("button", { name: /Details for/ })
    .first()
    .click();
  await page.getByRole("button", { name: "↓ Download", exact: true }).click();
  await page.getByLabel("Close dialog").click();
  await page.getByRole("button", { name: "Downloads", exact: true }).click();
  await expect(
    page.getByText("Ready to read offline", { exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("button", { name: "Downloads", exact: true }).click();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "Page 1", exact: true })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
});

test("a full device never reports an incomplete download as ready", async ({
  page,
}) => {
  await login(page);
  await page.evaluate(() => {
    Cache.prototype.put = async () => {
      throw new DOMException("Device storage is full", "QuotaExceededError");
    };
  });
  await page
    .getByRole("button", { name: /Details for/ })
    .first()
    .click();
  await page.getByRole("button", { name: "↓ Download", exact: true }).click();
  await page.getByLabel("Close dialog").click();
  await page.getByRole("button", { name: "Downloads", exact: true }).click();
  await expect(
    page.getByText("Device storage is full", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Read", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Ready to read offline", { exact: true }),
  ).toHaveCount(0);
});

test("reader modes preserve position and keep wide spreads unpaired", async ({
  page,
}) => {
  await login(page);
  await page.locator(".cover-button").first().click();
  await page.getByLabel("Reading mode").selectOption("double");
  await expect(page.locator(".spread img")).toHaveCount(1);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Page", { exact: true })).toHaveValue("2");
  await expect(page.locator(".spread img")).toHaveCount(2);
  await page.getByLabel("Page", { exact: true }).fill("5");
  await expect(page.locator(".spread img")).toHaveCount(1);
  await page.getByLabel("Reading mode").selectOption("vertical");
  await expect(page.getByLabel("Page", { exact: true })).toHaveValue("5");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Page", { exact: true })).toHaveValue("6");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reset zoom", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
});

test("metadata storage failure does not hide the online library", async ({
  page,
}) => {
  await login(page);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "meta")
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await expect(page.locator(".book-card")).toHaveCount(12);
  await expect(page.getByRole("alert")).toContainText(
    "Device storage is unavailable or full",
  );
  await expect(
    page.getByRole("button", { name: "Retry connection" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "↻ Refresh library" }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});

test.describe("connection recovery", () => {
  // Route interception must not be bypassed by a controlling service worker.
  test.use({ serviceWorkers: "block" });
  test("retry recovers library loading without a browser online event", async ({
    page,
  }) => {
    await login(page);
    await page.route("**/api/books?*", (route) => route.abort("failed"));
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Retry connection" }),
    ).toBeVisible();
    await page.unroute("**/api/books?*");
    await page.getByRole("button", { name: "Retry connection" }).click();
    await expect(page.locator(".book-card")).toHaveCount(12);
    await expect(
      page.getByRole("button", { name: "Retry connection" }),
    ).toHaveCount(0);
  });
});
