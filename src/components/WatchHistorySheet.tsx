import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Episode, type WatchedEpisode } from "../db";
import type { HistoryTarget } from "../lib/quickMenu";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import { useAnimatedDismiss } from "../lib/useAnimatedDismiss";
import { episodeWatchCount, movieFirstWatchedAt, movieWatchCount, repeatLabel, summarize, summarizeShow } from "../lib/watchHistory";

/** Matches the .episode-detail-modal exit this sheet borrows. */
const EXIT_MS = 200;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not recorded";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function ShowHistory({ episodes, watched }: { episodes: Episode[]; watched: WatchedEpisode[] }) {
  const summary = summarizeShow(episodes, watched);
  const byKey = new Map(watched.map((w) => [w.key, w]));
  const names = new Map(episodes.map((e) => [e.key, e.name]));
  const seasons = [...new Set(watched.map((w) => w.seasonNumber))].sort((a, b) => a - b);

  if (watched.length === 0) return <p className="muted">Nothing watched yet.</p>;

  return (
    <>
      <p className="muted small">
        {summary.uniqueWatched} of {summary.released || summary.uniqueWatched} episodes watched &middot;{" "}
        {summary.views} episode view{summary.views === 1 ? "" : "s"}
        {summary.completions >= 1 && ` · watched in full ${summary.completions}×`}
      </p>
      {seasons.map((n) => {
        const seasonEps = episodes.filter((e) => e.seasonNumber === n);
        const seasonSummary = summarize(seasonEps, byKey);
        const rows = watched.filter((w) => w.seasonNumber === n).sort((a, b) => a.episodeNumber - b.episodeNumber);
        const seasonRepeat = repeatLabel(seasonSummary.completions);
        return (
          <section key={n} className="history-season">
            <h3>
              Season {n}
              <span className="muted small">
                {" "}
                {seasonEps.length > 0 ? `${seasonSummary.watched}/${seasonSummary.total}` : rows.length}
              </span>
              {seasonRepeat && <span className="watch-count-badge">{seasonRepeat}</span>}
            </h3>
            <ul className="history-list">
              {rows.map((w) => {
                const count = episodeWatchCount(w);
                const last = w.lastWatchedAt ?? w.watchedAt;
                return (
                  <li key={w.key} className="history-row">
                    <span className="ep-number">E{w.episodeNumber}</span>
                    <span className="history-name">{names.get(w.key) ?? `Episode ${w.episodeNumber}`}</span>
                    {repeatLabel(count) && <span className="watch-count-badge">{repeatLabel(count)}</span>}
                    <span className="muted small history-dates">
                      First {formatDate(w.watchedAt)}
                      {count > 1 && last !== w.watchedAt && <> &middot; last {formatDate(last)}</>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/**
 * A title's viewing history, from the same rows every count in the app is
 * derived from: per episode, how many times and the first and latest dates.
 * Read live, so a change made elsewhere while it is open shows up here.
 */
export default function WatchHistorySheet({ target, onClose }: { target: HistoryTarget; onClose: () => void }) {
  useLockBodyScroll();
  const { closing, requestClose } = useAnimatedDismiss(onClose, EXIT_MS);
  useBackHandler(true, requestClose);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const data = useLiveQuery(async () => {
    if (target.kind === "show") {
      const [episodes, watched] = await Promise.all([
        db.episodes.where("showId").equals(target.tmdbId).toArray(),
        db.watchedEpisodes.where("showId").equals(target.tmdbId).toArray(),
      ]);
      return { kind: "show" as const, episodes, watched };
    }
    return { kind: "movie" as const, movie: await db.movies.get(target.tmdbId) };
  }, [target.kind, target.tmdbId]);

  let body;
  if (!data) body = <p className="muted">Loading...</p>;
  else if (data.kind === "show") body = <ShowHistory episodes={data.episodes} watched={data.watched} />;
  else if (!data.movie || !data.movie.watched) body = <p className="muted">Not watched.</p>;
  else {
    const count = movieWatchCount(data.movie);
    body = (
      <dl className="history-facts">
        <dt>Times watched</dt>
        <dd>{count}</dd>
        <dt>First watched</dt>
        <dd>{formatDate(movieFirstWatchedAt(data.movie))}</dd>
        {count > 1 && (
          <>
            <dt>Last watched</dt>
            <dd>{formatDate(data.movie.watchedAt)}</dd>
          </>
        )}
      </dl>
    );
  }

  return createPortal(
    <div className={`modal-backdrop history-backdrop ${closing ? "is-leaving" : ""}`} onClick={requestClose}>
      <div
        className={`modal episode-detail-modal watch-history-modal ${closing ? "is-leaving" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${target.name} watch history`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="close-x episode-detail-close" onClick={requestClose} aria-label="Close">
          &times;
        </button>
        <div className="episode-detail-body">
          <h2 className="episode-detail-title">{target.name}</h2>
          <p className="muted small">Watch history</p>
          {body}
        </div>
      </div>
    </div>,
    document.body
  );
}
