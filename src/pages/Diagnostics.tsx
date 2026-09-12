import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, episodeKey, type Episode, type Show, type WatchedEpisode } from "../db";
import { ensureEpisodesCached, findNextUnwatched } from "../lib/episodeSync";
import { daysSince, getStaleDaysThreshold } from "../lib/showStatus";
import { lastProgressionAt } from "../lib/watchEvents";
import { reactivationState, RELEASE_ACTIVATION_DAYS } from "../lib/releaseState";
import { isStoppedWatching } from "../lib/stoppedWatching";

export type HomeCategory =
  | "Watch Next"
  | "Haven't Watched For a While"
  | "Haven't Yet Started"
  | "Stopped Watching"
  | null;

/**
 * Replicates Home.tsx's categorize() EXACTLY, so the verdict printed here is
 * the truth about which of the three mutually-exclusive sections a show
 * lands in (or none). If Home's logic changes, this must change with it —
 * that coupling is the entire point of the tool.
 *
 * - Stopped Watching: the user said so (Show.isArchived). Beats everything.
 * - Haven't Yet Started: zero watch activity ever.
 * - (else, has activity) no next unseen episode -> null (caught up /
 *   finished; rewatches never resurface it).
 * - (else) next unseen episode exists -> Watch Next if a release REACTIVATES
 *   the show, OR if last PROGRESSION is within the threshold; otherwise
 *   Haven't Watched For a While.
 *
 * The release check comes before the staleness one and is the reason this tool
 * exists in its current form: a returning series used to be filed as stale
 * purely because the user's history was old, while the notification system
 * announced its new season on the same day. But a release only reactivates a
 * show the user was CAUGHT UP on - an episode landing on top of a backlog they
 * never worked through says they stopped, not that they are waiting - so the
 * report below prints both halves of that test. The split still uses
 * progression (max watchedAt = last time an unseen episode was first-watched)
 * rather than last activity, so a rewatch cannot drag a stalled show back into
 * Watch Next.
 */
function watchNextVerdict(
  show: Show,
  episodes: Episode[],
  watched: WatchedEpisode[]
): { lines: string[]; category: HomeCategory } {
  const threshold = getStaleDaysThreshold();
  const watchedKeys = new Set(watched.map((w) => w.key));
  const next = findNextUnwatched(episodes, watchedKeys);
  const today = new Date().toISOString().slice(0, 10);
  const releasedUnwatched = episodes.filter((e) => (!e.airDate || e.airDate <= today) && !watchedKeys.has(e.key));

  const activityDs = daysSince(show.lastWatchedAt); // last activity of any kind (rewatch bumps this)
  const progressedAt = lastProgressionAt(watched); // last first-watch of an unseen episode
  const progressionDs = daysSince(progressedAt);
  // Release state: what has just come out, and whether the user was caught up
  // when it did. Only the pair of them outranks the inactivity rules below.
  const release = reactivationState(episodes, watchedKeys);

  const lines: string[] = [];
  lines.push(`isFollowed=${show.isFollowed}, isArchived=${show.isArchived}, tvTimeStatus=${show.tvTimeStatus ?? "(none: CSV import or manual add)"}`);
  lines.push(`Last activity (any watch/rewatch): ${show.lastWatchedAt ?? "(never)"}${activityDs !== null ? ` (${activityDs} days ago)` : ""}`);
  lines.push(`Last PROGRESSION (first-watch of an unseen ep): ${progressedAt ?? "(never)"}${progressionDs !== null ? ` (${progressionDs} days ago)` : ""} — this drives the split`);
  lines.push(`Cached episodes: ${episodes.length}, watched records: ${watched.length}, released-and-unwatched in cache: ${releasedUnwatched.length}`);
  lines.push(
    `Next unseen per cache: ${next ? `S${next.seasonNumber}E${next.episodeNumber} "${next.name}" (air_date=${next.airDate ?? "unknown"})` : "none"}`
  );
  const summarise = (list: Episode[]) =>
    list.length === 0
      ? "none"
      : list
          .slice(0, 5)
          .map((ep) => `S${ep.seasonNumber}E${ep.episodeNumber} (${ep.airDate ?? "no date"})`)
          .join(", ") + (list.length > 5 ? `, +${list.length - 5} more` : "");

  lines.push(
    `Newly available (unwatched, released in the last ${RELEASE_ACTIVATION_DAYS} days): ${summarise(release.newlyAvailable)}`
  );
  lines.push(
    `Unwatched backlog released BEFORE those: ${summarise(release.backlog)} — empty means the user was caught up ` +
      "when the new content arrived, which is what separates a returning show from an abandoned one"
  );
  lines.push(
    `Reactivates: ${release.reactivates} (needs newly-available AND an empty backlog; beats the staleness rule when true)`
  );

  let category: HomeCategory = null;
  if (isStoppedWatching(show)) {
    category = "Stopped Watching";
    lines.push(
      'CATEGORY: "Stopped Watching" — set explicitly by the user (or imported from TV Time\'s own "stopped" ' +
        "status). Checked before every rule below, so no release reactivates it and it appears in neither Watch " +
        "Next nor Haven't Watched For a While until it is resumed. History is untouched either way."
    );
  } else if (!show.isFollowed) {
    lines.push("EXCLUDED from all sections: not followed.");
  } else if (watched.length === 0) {
    category = "Haven't Yet Started";
    lines.push('CATEGORY: "Haven\'t Yet Started" — in the library, zero watch activity ever.');
  } else if (next === null) {
    lines.push(
      "CATEGORY: none — every released episode is watched (caught up / finished), or nothing is cached yet. " +
        "Rewatching an old episode updates history/time/recency but never resurfaces the show here."
    );
  } else if (release.reactivates) {
    category = "Watch Next";
    lines.push(
      `CATEGORY: "Watch Next" — ${release.newlyAvailable.length} unwatched episode(s) became available within the ` +
        `last ${RELEASE_ACTIVATION_DAYS} days AND nothing older was left unwatched, so this is a show the user was ` +
        `keeping up with. That outranks the ${threshold}-day staleness rule entirely: last progression was ` +
        `${progressionDs === null ? "never" : `${progressionDs} days ago`}, which is not evidence about content ` +
        `that did not exist when they stopped. The episode OFFERED is still the next one in order (above), not the ` +
        `newest release.`
    );
  } else {
    const days = progressionDs ?? 0;
    category = days < threshold ? "Watch Next" : "Haven't Watched For a While";
    lines.push(
      `CATEGORY: "${category}" — started, next unseen episode exists, no release reactivated it` +
        (release.newlyAvailable.length > 0
          ? ` (${release.newlyAvailable.length} episode(s) DID come out recently, but ${release.backlog.length} ` +
            "older released episode(s) are still unwatched, so this reads as a show that was stopped rather than " +
            "one being kept up with)"
          : " (nothing newly available)") +
        `; last progression ${progressionDs === null ? "never (counts as 0 days)" : `${progressionDs} days ago`} vs ` +
        `${threshold}-day threshold (configurable in Settings). ` +
        `(Last activity was ${activityDs ?? "?"} days ago — deliberately NOT used, so rewatches don't move the show.)`
    );
  }
  return { lines, category };
}

export default function Diagnostics() {
  const shows = useLiveQuery(() => db.shows.orderBy("name").toArray(), []);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runDiagnostic(tmdbId: number) {
    setLoading(true);
    setReport(null);
    const show = await db.shows.get(tmdbId);
    const watched = await db.watchedEpisodes.where("showId").equals(tmdbId).toArray();
    // A diagnostics tool must still produce a report when TMDB is down or
    // the key is bad — that's precisely when you need it. Fall back to
    // whatever is already cached and say so, instead of dying silently.
    let syncWarning: string | null = null;
    try {
      await ensureEpisodesCached(tmdbId);
    } catch (e) {
      syncWarning = e instanceof Error ? e.message : String(e);
    }
    const cachedEpisodes = await db.episodes.where("showId").equals(tmdbId).toArray();

    const watchedKeySet = new Set(watched.map((w) => w.key));
    const cachedKeySet = new Set(cachedEpisodes.map((e) => e.key));

    // Watched records with no matching cached TMDB episode: either a season/
    // episode numbering mismatch between TV Time and TMDB, or TMDB simply
    // doesn't have that episode listed.
    const orphanedWatched = watched.filter((w) => !cachedKeySet.has(w.key));

    // Cached TMDB episodes with no matching watched record: either genuinely
    // unwatched, or a numbering mismatch hiding a real watch on the other side.
    const unwatchedPerApp = cachedEpisodes.filter((e) => !watchedKeySet.has(e.key));

    const lines: string[] = [];
    lines.push(`Show: ${show?.name} (tmdbId ${tmdbId})`);
    if (syncWarning) {
      lines.push(`WARNING: TMDB sync failed (${syncWarning}) — everything below uses the existing local cache only.`);
    }
    lines.push(`Watched records in IndexedDB: ${watched.length}`);
    lines.push(`Cached TMDB episodes: ${cachedEpisodes.length}`);
    lines.push(`Orphaned watched records (no matching TMDB episode key): ${orphanedWatched.length}`);
    if (orphanedWatched.length > 0) {
      lines.push(
        "  Sample orphaned keys: " +
          orphanedWatched
            .slice(0, 10)
            .map((w) => `S${w.seasonNumber}E${w.episodeNumber} (key=${w.key})`)
            .join(", ")
      );
    }
    lines.push(`TMDB episodes the app thinks are unwatched: ${unwatchedPerApp.length}`);
    if (unwatchedPerApp.length > 0) {
      lines.push(
        "  First 10 by season/episode order: " +
          [...unwatchedPerApp]
            .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
            .slice(0, 10)
            .map((e) => `S${e.seasonNumber}E${e.episodeNumber} (air_date=${e.airDate ?? "MISSING"})`)
            .join(", ")
      );
      const today = new Date().toISOString().slice(0, 10);
      const confirmedFuture = unwatchedPerApp.filter((e) => e.airDate && e.airDate > today);
      if (confirmedFuture.length > 0) {
        lines.push(
          `  Of those, ${confirmedFuture.length} have a CONFIRMED future air_date (after ${today}) and are ` +
            `correctly excluded from Watch Next as not yet available. Everything else (including missing air_date) ` +
            `is treated as available.`
        );
      }
    }
    // Direct spot check: does S1E1 exist on both sides, and do the keys match exactly?
    const expectedS1E1Key = episodeKey(tmdbId, 1, 1);
    lines.push("");
    lines.push(`S1E1 expected key: ${expectedS1E1Key}`);
    lines.push(`  In watched records: ${watchedKeySet.has(expectedS1E1Key)}`);
    lines.push(`  In cached TMDB episodes: ${cachedKeySet.has(expectedS1E1Key)}`);

    if (show) {
      lines.push("");
      lines.push("--- Home category verdict (replicates Home.tsx exactly) ---");
      lines.push(...watchNextVerdict(show, cachedEpisodes, watched).lines);
    }

    setReport(lines.join("\n"));
    setLoading(false);
  }

  /**
   * One-paste overview of the whole library against Home's gates, WITHOUT
   * fetching anything (uses whatever is cached right now, exactly like
   * Home's rows computation does between sync writes). The per-show
   * diagnostic above force-syncs its one show first; this deliberately
   * doesn't, so "zero cached" counts reflect the app's true resting state.
   */
  async function runLibrarySummary() {
    setLoading(true);
    setReport(null);
    const [shows, episodes, watched] = await Promise.all([
      db.shows.toArray(),
      db.episodes.toArray(),
      db.watchedEpisodes.toArray(),
    ]);

    const episodesByShow = new Map<number, Episode[]>();
    for (const ep of episodes) {
      const list = episodesByShow.get(ep.showId);
      if (list) list.push(ep);
      else episodesByShow.set(ep.showId, [ep]);
    }
    const watchedByShow = new Map<number, WatchedEpisode[]>();
    for (const w of watched) {
      const list = watchedByShow.get(w.showId);
      if (list) list.push(w);
      else watchedByShow.set(w.showId, [w]);
    }

    // Archived shows are INCLUDED now: they are Home's fourth tab rather than
    // a hidden state, so a summary that dropped them would under-report the
    // library by exactly the shows the user had put somewhere on purpose.
    const followed = shows.filter((s) => s.isFollowed);
    const statusCounts = new Map<string, number>();
    let inWatchNext = 0;
    let inStale = 0;
    let inNotStarted = 0;
    let inStopped = 0;
    // Shows a release DID reach but did not reactivate, because older released
    // episodes are still unwatched. Listed by name: this is the answer to "why
    // is my show not in Watch Next when I just got a notification for it", and
    // it is the one verdict a user is most likely to want to argue with.
    const releasedButBehind: string[] = [];
    const excludedFinished: string[] = [];

    for (const s of followed) {
      const statusLabel = s.tvTimeStatus ?? "(none)";
      statusCounts.set(statusLabel, (statusCounts.get(statusLabel) ?? 0) + 1);

      const eps = episodesByShow.get(s.tmdbId) ?? [];
      const w = watchedByShow.get(s.tmdbId) ?? [];
      const { category } = watchNextVerdict(s, eps, w);
      if (category === "Watch Next") inWatchNext++;
      else if (category === "Haven't Watched For a While") inStale++;
      else if (category === "Haven't Yet Started") inNotStarted++;
      else if (category === "Stopped Watching") inStopped++;
      else excludedFinished.push(s.name);

      if (category !== "Watch Next" && category !== "Stopped Watching") {
        const release = reactivationState(eps, new Set(w.map((x) => x.key)));
        if (release.newlyAvailable.length > 0 && !release.reactivates) {
          releasedButBehind.push(`${s.name} (${release.backlog.length} older unwatched)`);
        }
      }
    }

    const lines: string[] = [];
    lines.push(`Followed: ${followed.length} of ${shows.length} shows`);
    lines.push(`tvTimeStatus distribution: ${[...statusCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
    lines.push("");
    lines.push(`"Watch Next" (started, next unseen episode, active within ${getStaleDaysThreshold()} days or newly reactivated): ${inWatchNext}`);
    lines.push(`"Haven't Watched For a While" (started, next unseen episode, stopped for a while): ${inStale}`);
    lines.push(`"Haven't Yet Started" (in library, never watched an episode): ${inNotStarted}`);
    lines.push(`"Stopped Watching" (explicitly stopped; no release reactivates these): ${inStopped}`);
    lines.push(`Not shown, finished/caught up (all released episodes watched; rewatches don't resurface): ${excludedFinished.length}`);
    if (excludedFinished.length > 0) lines.push(`  ${excludedFinished.slice(0, 15).join(", ")}${excludedFinished.length > 15 ? ", ..." : ""}`);
    lines.push("");
    lines.push(
      `Had new episodes but were NOT reactivated (older released episodes still unwatched): ${releasedButBehind.length}`
    );
    if (releasedButBehind.length > 0) {
      lines.push(`  ${releasedButBehind.slice(0, 15).join(", ")}${releasedButBehind.length > 15 ? ", ..." : ""}`);
    }
    lines.push("");
    lines.push(
      `(The four sections are mutually exclusive: ${inWatchNext} + ${inStale} + ${inNotStarted} + ${inStopped} = ` +
        `${inWatchNext + inStale + inNotStarted + inStopped} shows on Home, plus ${excludedFinished.length} finished.)`
    );

    setReport(lines.join("\n"));
    setLoading(false);
  }

  return (
    <div className="panel">
      <h3>Diagnostics</h3>
      <p className="muted small">
        Pick a show to compare what's actually stored in your local database against what TMDB reports, to find
        real mismatches instead of guessing at them.
      </p>
      <div className="field-row">
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Select a show...</option>
          {shows?.map((s) => (
            <option key={s.tmdbId} value={s.tmdbId}>
              {s.name}
            </option>
          ))}
        </select>
        <button disabled={!selectedId || loading} onClick={() => selectedId && runDiagnostic(selectedId)}>
          {loading ? "Checking..." : "Run diagnostic"}
        </button>
      </div>
      <div className="field-row">
        <button disabled={loading} onClick={runLibrarySummary}>
          Library-wide Watch Next summary
        </button>
        <span className="muted small">
          Counts every followed show against Home's inclusion rules, using only what's cached right now.
        </span>
      </div>
      {report && <pre className="diagnostic-report">{report}</pre>}
    </div>
  );
}
