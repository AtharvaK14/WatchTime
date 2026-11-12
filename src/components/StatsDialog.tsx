import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import { useAnimatedDismiss } from "../lib/useAnimatedDismiss";
import { toDurationParts } from "../lib/stats";
import { movieLibraryStats, showLibraryStats, type MonthCount, type RankedTitle } from "../lib/libraryStats";
import type { ShowWatchStatus } from "../lib/showWatchStatus";

/** Matches the .episode-detail-modal exit this dialog borrows. */
const EXIT_MS = 200;

/** Months the "Watched by month" chart covers, ending with this one. */
const CHART_MONTHS = 12;

function duration(minutes: number): string {
  const d = toDurationParts(minutes);
  return `${d.months}mo ${d.days}d ${d.hours}h`;
}

/** The shell both stats dialogs share: same surface, close button, Escape, Android back, tap outside. */
function StatsShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
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

  return createPortal(
    <div className={`modal-backdrop stats-backdrop ${closing ? "is-leaving" : ""}`} onClick={requestClose}>
      <div
        className={`modal episode-detail-modal stats-modal ${closing ? "is-leaving" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="close-x episode-detail-close" onClick={requestClose} aria-label="Close">
          &times;
        </button>
        <div className="episode-detail-body">
          <h2 className="episode-detail-title">{title}</h2>
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="stats-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Label / value rows. A note under a value says what it covers where that is not obvious. */
function Facts({ rows }: { rows: { label: string; value: ReactNode; note?: string }[] }) {
  return (
    <dl className="stats-facts">
      {rows.map((r) => (
        <div key={r.label} className="stats-fact">
          <dt>
            {r.label}
            {r.note && <span className="stats-note">{r.note}</span>}
          </dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Ranking({ items, unit }: { items: RankedTitle[]; unit: (t: RankedTitle) => string }) {
  return (
    <ol className="stats-ranking">
      {items.map((t) => (
        <li key={t.tmdbId}>
          <span className="stats-ranking-name">{t.name}</span>
          <span className="muted small">{unit(t)}</span>
        </li>
      ))}
    </ol>
  );
}

const fmt = (n: number) => n.toLocaleString();

/**
 * The Shows tab's detailed statistics. Show states use the Shows page's own
 * watch-status computation (passed in, not recomputed), so "Currently
 * watching" here is exactly what that filter shows.
 */
export function ShowStatsDialog({
  totalMinutes,
  statusByShow,
  statusesReady,
  onClose,
}: {
  totalMinutes: number;
  statusByShow: ReadonlyMap<number, ShowWatchStatus>;
  statusesReady: boolean;
  onClose: () => void;
}) {
  const data = useLiveQuery(async () => {
    const [shows, episodes, watched] = await Promise.all([
      db.shows.toArray(),
      db.episodes.toArray(),
      db.watchedEpisodes.toArray(),
    ]);
    return { shows, episodes, watched };
  }, []);

  let body: ReactNode = <p className="muted">Loading...</p>;
  if (data) {
    const s = showLibraryStats(data.shows, data.episodes, data.watched, statusByShow, new Date(), CHART_MONTHS);
    body = (
      <>
        <Section title="Library">
          <Facts
            rows={[
              { label: "Shows in your library", value: fmt(s.totalShows) },
              { label: "Currently watching", value: statusesReady ? fmt(s.currentlyWatching) : "..." },
              { label: "Caught up", note: "Every released episode watched", value: statusesReady ? fmt(s.caughtUp) : "..." },
              { label: "Not started", value: statusesReady ? fmt(s.notStarted) : "..." },
              { label: "Stopped watching", value: fmt(s.stopped) },
              ...(statusesReady && s.unknown > 0
                ? [{ label: "Not synced yet", note: "Episode list not on this device, so its state is unknown", value: fmt(s.unknown) }]
                : []),
            ]}
          />
        </Section>
        <Section title="Episodes">
          <Facts
            rows={[
              { label: "Episodes watched", note: "Every viewing, rewatches included", value: fmt(s.episodeViews) },
              { label: "Unique episodes", value: fmt(s.uniqueEpisodes) },
              { label: "Rewatches", value: fmt(s.rewatchViews) },
              { label: "Seasons watched through", note: "Of seasons synced on this device", value: fmt(s.seasonsCompleted) },
              { label: "TV time", value: duration(totalMinutes) },
            ]}
          />
        </Section>
        <Section title="Watched by month">
          <MonthChart data={s.firstWatchesByMonth} noun="episode" />
        </Section>
      </>
    );
  }

  return (
    <StatsShell title="Show statistics" onClose={onClose}>
      {body}
    </StatsShell>
  );
}

/** The Movies tab's detailed statistics. */
export function MovieStatsDialog({ totalMinutes, onClose }: { totalMinutes: number; onClose: () => void }) {
  const movies = useLiveQuery(() => db.movies.toArray(), []);

  let body: ReactNode = <p className="muted">Loading...</p>;
  if (movies) {
    const s = movieLibraryStats(movies, new Date(), CHART_MONTHS);
    body = (
      <>
        <Section title="Library">
          <Facts
            rows={[
              { label: "Movies in your library", value: fmt(s.totalMovies) },
              { label: "Movies watched", value: fmt(s.watched) },
              { label: "Not watched", value: fmt(s.unwatched) },
            ]}
          />
        </Section>
        <Section title="Viewings">
          <Facts
            rows={[
              { label: "Movie viewings", note: "Every viewing, rewatches included", value: fmt(s.views) },
              { label: "Rewatches", value: fmt(s.rewatchViews) },
              { label: "Movie time", value: duration(totalMinutes) },
            ]}
          />
        </Section>
        <Section title="Watched by month">
          <MonthChart data={s.firstWatchesByMonth} noun="movie" />
        </Section>
        {s.mostRewatched.length > 0 && (
          <Section title="Most rewatched">
            <Ranking items={s.mostRewatched} unit={(t) => `${fmt(t.views)} viewings`} />
          </Section>
        )}
      </>
    );
  }

  return (
    <StatsShell title="Movie statistics" onClose={onClose}>
      {body}
    </StatsShell>
  );
}

/**
 * Twelve months as bars, the Digital Wellbeing way: the selected month's
 * count large above the chart (this month to begin with), tap a bar to read
 * another, and a dashed line for the monthly average. Bars are the watched
 * green; the selected one is solid, the rest a step back.
 *
 * Counts first viewings: the only viewings every record has a date for.
 */
function MonthChart({ data, noun }: { data: MonthCount[]; noun: string }) {
  const [selected, setSelected] = useState(data.length - 1);
  const peak = Math.max(1, ...data.map((m) => m.count));
  const average = data.reduce((sum, m) => sum + m.count, 0) / Math.max(1, data.length);
  const current = data[Math.min(selected, data.length - 1)];
  if (!current) return null;
  return (
    <div className="month-chart">
      <div className="month-chart-head" aria-live="polite">
        <span className="month-chart-value">{fmt(current.count)}</span>
        <span className="month-chart-caption">
          {noun}
          {current.count === 1 ? "" : "s"} in {monthLabel(current.month)}
        </span>
        {average > 0 && (
          <span className="month-chart-average">
            <span className="month-chart-avg-key" aria-hidden="true" />
            Monthly average {fmt(Math.round(average))}
          </span>
        )}
      </div>
      <div className="month-chart-plot">
        {average > 0 && (
          <span className="month-chart-avg" style={{ bottom: `${(average / peak) * 100}%` }} aria-hidden="true" />
        )}
        {data.map((m, i) => (
          <button
            key={m.month}
            type="button"
            className={`month-chart-bar${i === selected ? " is-selected" : ""}`}
            aria-pressed={i === selected}
            aria-label={`${monthLabel(m.month)}: ${fmt(m.count)}`}
            onClick={() => setSelected(i)}
          >
            <span className="month-chart-fill" style={{ height: `${(m.count / peak) * 100}%` }} />
          </button>
        ))}
      </div>
      <div className="month-chart-axis" aria-hidden="true">
        {data.map((m, i) => (
          <span key={m.month} className={i === selected ? "is-selected" : ""}>
            {monthLabel(m.month, true).slice(0, 1)}
          </span>
        ))}
      </div>
      <p className="month-chart-note">First viewings. Imported rewatches carry no dates, so they are not counted.</p>
    </div>
  );
}

function monthLabel(month: string, short = false): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    ...(short ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
