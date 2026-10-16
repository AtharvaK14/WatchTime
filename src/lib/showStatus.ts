// Threshold for the "Haven't Watched For a While" bucket: days with no
// watch activity before a show counts as "genuinely stopped watching" and
// moves off Watch Next (the two lists are mutually exclusive by design).
// User-configurable in Settings because there's no objectively correct
// number; 60 is the agreed default.
export const DEFAULT_STALE_DAYS_THRESHOLD = 60;

const STALE_DAYS_STORAGE_KEY = "stale_days_threshold";

export function getStaleDaysThreshold(): number {
  const raw = localStorage.getItem(STALE_DAYS_STORAGE_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  // Guard against junk values: a threshold under 1 day (or NaN) would make
  // every show "stale" the moment it's watched.
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_STALE_DAYS_THRESHOLD;
}

export function setStaleDaysThreshold(days: number): void {
  localStorage.setItem(STALE_DAYS_STORAGE_KEY, String(Math.floor(days)));
}

export function daysSince(isoDate: string | null, now = new Date()): number | null {
  if (!isoDate) return null;
  const then = new Date(isoDate).getTime();
  return Math.floor((now.getTime() - then) / (1000 * 60 * 60 * 24));
}
