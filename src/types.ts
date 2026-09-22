export type Format = "CBZ" | "CBR" | "PDF" | "EPUB" | "OTHER";
export type Preferences = {
  direction: "rtl" | "ltr";
  mode: "single" | "double" | "vertical";
  fit: "page" | "width";
  offset: number;
};
export const defaultPreferences: Preferences = {
  direction: "rtl",
  mode: "single",
  fit: "page",
  offset: 0,
};
export type Progress = {
  bookId: string;
  page: number;
  cfi: string | null;
  completed: boolean;
  version: number;
  updatedAt: string;
};
export type Book = {
  id: string;
  komgaId: string;
  title: string;
  sourceTitle: string;
  volume: string;
  format: Format;
  pages: number;
  available: boolean;
  revision: string;
  summary: string;
  seriesId: string | null;
  position: number | null;
  progress: Progress;
};
export type Series = {
  id: string;
  title: string;
  preferences: Preferences;
  count: number;
};
export type Collection = { id: string; title: string; seriesIds: string[] };
export type Page = { number: number; width: number; height: number };
export type SourceBook = {
  komgaId: string;
  title: string;
  format: Format;
  pages: number;
  available: boolean;
  revision: string;
  summary: string;
};
export type PendingProgress = {
  bookId: string;
  page: number;
  cfi: string | null;
  completed: boolean;
  baseVersion: number;
  mutationId: string;
};
