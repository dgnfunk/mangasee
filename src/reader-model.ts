import type { Page } from "./types";
export function spreads(pages: Page[], offset = 0): number[][] {
  const groups: number[][] = [];
  let i = 0;
  while (i < pages.length) {
    const p = pages[i];
    if (
      i === 0 ||
      (offset === 1 && i === 1) ||
      p.width > p.height ||
      !pages[i + 1] ||
      pages[i + 1].width > pages[i + 1].height
    ) {
      groups.push([p.number]);
      i++;
    } else {
      groups.push([p.number, pages[i + 1].number]);
      i += 2;
    }
  }
  return groups;
}
