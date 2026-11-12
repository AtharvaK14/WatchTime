/**
 * TMDB's episode_run_time is an array (sometimes with multiple values for
 * shows with varying episode lengths, sometimes empty for shows lacking the
 * data, confirmed directly from TMDB's own staff on their forum: they do not
 * track true per-episode runtime, this field is a show-level average, and it
 * can be empty). Average what's there.
 *
 * FALLBACK_RUNTIME_MINUTES is used only when TMDB has nothing at all for a
 * show. This is a judgment call, not a TMDB-confirmed number, there is no
 * "correct" universal answer since actual runtimes vary from ~22 (sitcoms)
 * to ~60+ (dramas) minutes. 40 is a rough middle estimate. This existing
 * specifically so an affected show contributes SOMETHING to your total
 * rather than silently zero forever, which was the actual bug: previously
 * a missing value was cached as null and never retried, permanently
 * excluding that show from your stats with no way to self-correct.
 */
const FALLBACK_RUNTIME_MINUTES = 40;

export function averageRuntime(episodeRunTimes: number[]): number {
  if (!episodeRunTimes || episodeRunTimes.length === 0) return FALLBACK_RUNTIME_MINUTES;
  const sum = episodeRunTimes.reduce((a, b) => a + b, 0);
  return sum / episodeRunTimes.length;
}

/** "2h 35m" / "45m" / "2h". */
export function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
