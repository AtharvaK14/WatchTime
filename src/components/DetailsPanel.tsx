import { useEffect, useState } from "react";
import { db, type Episode, type Movie } from "../db";
import {
  getTvShowDetails,
  getMovieDetails,
  TMDB_IMAGE_BASE,
  TMDB_BACKDROP_BASE,
  TMDB_STILL_BASE,
} from "../tmdb";
import { getOmdbRatings, hasOmdbKey, OMDB_RATE_LIMIT_MESSAGE, type OmdbRatings } from "../omdb";
import { averageRuntime } from "../lib/runtime";
import { getSeasonSummaries, ensureSeasonCached, totalEpisodeCount } from "../lib/episodeSync";
import { ensureEpisodesWatched, recordEpisodeRewatch, recordMovieRewatch } from "../lib/watchEvents";
import { useDraggableSheet } from "../lib/useDraggableSheet";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { usePrefersBottomSheet } from "../lib/useIsMobile";
import { useBackHandler } from "../lib/backHandler";
import EpisodeDetailsPanel from "./EpisodeDetailsPanel";
import { CheckIcon, CloseIcon } from "./icons";
import { DetailsSkeleton, LoadingAnnouncement } from "./Skeleton";
import { useScrollAtEnd } from "../lib/useScrollAtEnd";

interface Props {
  kind: "show" | "movie";
  tmdbId: number;
  onClose: () => void;
}

interface CoreDetails {
  name: string;
  posterPath: string | null;
  backdropPath: string | null; // horizontal image, used unblurred in the mobile hero when TMDB has one
  releaseDate: string | null;
  overview: string | null;
  status?: string; // shows only
  numberOfSeasons?: number; // shows only
  numberOfEpisodes?: number; // shows only, sum of episode_count across real seasons
  episodeRuntimeMinutes?: number | null; // shows only
  runtimeMinutes?: number | null; // movies only
  imdbId?: string | null;
  genres: string[];
}

/** Release year / genres / season count / status, shared by both the
 * desktop header (next to the poster) and the mobile header (below the
 * hero banner), so the two render paths never drift out of sync on what
 * they display. */
function MetaLine({ details }: { details: CoreDetails }) {
  return (
    <>
      {details.releaseDate ? details.releaseDate.slice(0, 4) : "Release date unknown"}
      {details.genres.length > 0 ? ` \u00b7 ${details.genres.join(", ")}` : ""}
      {details.numberOfSeasons
        ? ` \u00b7 ${details.numberOfSeasons} season${details.numberOfSeasons === 1 ? "" : "s"}`
        : ""}
      {details.status ? ` \u00b7 ${details.status}` : ""}
    </>
  );
}

export default function DetailsPanel({ kind, tmdbId, onClose }: Props) {
  // This component is only ever mounted while its modal is open (callers
  // use `{openDetails !== null && <DetailsPanel .../>}`), so it's safe to
  // call these unconditionally, they mount/unmount together with the panel.
  // useLockBodyScroll applies on BOTH mobile and desktop, that bug wasn't
  // mobile-specific. useDraggableSheet's output is only wired into the
  // JSX on the mobile render path below, it's inert otherwise.
  useLockBodyScroll();
  const { sheetStyle, handleProps, sheetRef } = useDraggableSheet(onClose);
  // Sheet vs centred dialog. Portrait-aware, not the 640px phone breakpoint —
  // see usePrefersBottomSheet for why.
  const isMobile = usePrefersBottomSheet();
  // Drives the sheet's bottom fade: it should stop suggesting "more below"
  // once the scroll area has actually reached the bottom.
  const [scrollAreaRef, atEnd] = useScrollAtEnd();
  // Android back closes this panel instead of the app. A stacked episode
  // panel registers its own handler on top, so back closes that first.
  useBackHandler(true, onClose);

  const [details, setDetails] = useState<CoreDetails | null>(null);
  const [ratings, setRatings] = useState<OmdbRatings | null | "loading">("loading");
  const [inLibrary, setInLibrary] = useState(false);
  const [movieWatched, setMovieWatched] = useState(false); // movies only
  const [movieRewatchCount, setMovieRewatchCount] = useState(0); // movies only, extra watches beyond the first
  const [added, setAdded] = useState(false);
  const [removeConfirming, setRemoveConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [seasonNumbers, setSeasonNumbers] = useState<number[] | null>(null);
  // TMDB's episode_count per season, handed to ensureSeasonCached so it can
  // tell a complete cached season from one that has since gained episodes.
  const [seasonCounts, setSeasonCounts] = useState<Map<number, number>>(new Map());
  const [expandedSeason, setExpandedSeason] = useState<number | null>(null);
  const [loadingSeason, setLoadingSeason] = useState<number | null>(null);
  const [episodesInDb, setEpisodesInDb] = useState<Episode[]>([]);
  const [watchedKeys, setWatchedKeys] = useState<Set<string>>(new Set());
  // Total watch events per episode key, so the episode panel can show a live
  // rewatch count (+N) as "Watch again" is pressed.
  const [watchCountByKey, setWatchCountByKey] = useState<Map<string, number>>(new Map());
  const [openEpisode, setOpenEpisode] = useState<Episode | null>(null);

  // Escape closes this panel, unless the episode panel is stacked on top
  // of it (openEpisode set), in which case that panel's own Escape
  // handler (added alongside it in EpisodeDetailsPanel.tsx) should close
  // just that top layer first, not both at once.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !openEpisode) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, openEpisode]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (kind === "show") {
          const d = await getTvShowDetails(tmdbId);
          if (cancelled) return;
          setDetails({
            name: d.name,
            posterPath: d.poster_path,
            backdropPath: d.backdrop_path,
            releaseDate: d.first_air_date,
            overview: d.overview,
            status: d.status,
            numberOfSeasons: d.number_of_seasons,
            numberOfEpisodes: totalEpisodeCount(d.seasons),
            episodeRuntimeMinutes: averageRuntime(d.episode_run_time),
            imdbId: d.external_ids?.imdb_id ?? null,
            genres: d.genres.map((g) => g.name),
          });
          const existing = await db.shows.get(tmdbId);
          setInLibrary(!!existing);
          const summaries = await getSeasonSummaries(tmdbId);
          if (!cancelled) {
            setSeasonNumbers(summaries.map((x) => x.seasonNumber));
            setSeasonCounts(new Map(summaries.map((x) => [x.seasonNumber, x.episodeCount])));
          }
          if (existing) {
            await refreshWatchedAndEpisodes();
          }
          if (hasOmdbKey()) {
            const r = await getOmdbRatings({
              imdbId: d.external_ids?.imdb_id,
              title: d.name,
              year: d.first_air_date ? Number(d.first_air_date.slice(0, 4)) : null,
            });
            if (!cancelled) setRatings(r);
          } else {
            setRatings(null);
          }
        } else {
          const d = await getMovieDetails(tmdbId);
          if (cancelled) return;
          setDetails({
            name: d.title,
            posterPath: d.poster_path,
            backdropPath: d.backdrop_path,
            releaseDate: d.release_date,
            overview: d.overview,
            runtimeMinutes: d.runtime,
            imdbId: d.external_ids?.imdb_id ?? null,
            genres: d.genres.map((g) => g.name),
          });
          const existing = await db.movies.get(tmdbId);
          setInLibrary(!!existing);
          setMovieWatched(existing?.watched ?? false);
          setMovieRewatchCount(existing?.rewatchCount ?? 0);
          if (hasOmdbKey()) {
            const r = await getOmdbRatings({
              imdbId: d.external_ids?.imdb_id,
              title: d.title,
              year: d.release_date ? Number(d.release_date.slice(0, 4)) : null,
            });
            if (!cancelled) setRatings(r);
          } else {
            setRatings(null);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, tmdbId]);

  async function refreshWatchedAndEpisodes() {
    const [eps, watched] = await Promise.all([
      db.episodes.where("showId").equals(tmdbId).toArray(),
      db.watchedEpisodes.where("showId").equals(tmdbId).toArray(),
    ]);
    setEpisodesInDb(eps);
    setWatchedKeys(new Set(watched.map((w) => w.key)));
    setWatchCountByKey(new Map(watched.map((w) => [w.key, w.watchCount ?? 1])));
  }

  async function toggleExpand(seasonNumber: number) {
    if (expandedSeason === seasonNumber) {
      setExpandedSeason(null);
      return;
    }
    setExpandedSeason(seasonNumber);

    // Always ask, rather than only when nothing is cached locally.
    //
    // The old `if (no episodes for this season)` guard made the season cache
    // permanently self-confirming: having anything cached meant never asking
    // again, so a season that had gained episodes — or whose placeholder
    // entries had since been filled in with real titles and stills — could
    // never be corrected by opening it. ensureSeasonCached now owns that
    // decision and returns immediately when the cache is genuinely complete
    // and fresh, so this stays cheap.
    const cachedForSeason = episodesInDb.filter((e) => e.seasonNumber === seasonNumber).length;
    // Only show the spinner when there is nothing to display yet; a
    // background top-up should not blank out a list the user is reading.
    if (cachedForSeason === 0) setLoadingSeason(seasonNumber);
    await ensureSeasonCached(tmdbId, seasonNumber, seasonCounts.get(seasonNumber));
    await refreshWatchedAndEpisodes();
    setLoadingSeason(null);
  }

  const [catchUpOffer, setCatchUpOffer] = useState<{ episodesInSeason: Episode[]; earlierSeasonNumbers: number[] } | null>(
    null
  );

  // Idempotent "make these count as watched" via the shared write path:
  // already-watched rows keep their history (the old inline bulkPut reset
  // imported watchCounts back to 1), and Show.lastWatchedAt gets bumped so
  // panel-marked activity counts as activity for the Watch Next split
  // (previously only Home's checkmark did that).
  async function markEpisodesWatched(eps: Episode[]) {
    await ensureEpisodesWatched(tmdbId, eps);
    await refreshWatchedAndEpisodes();
  }

  // One more watch EVENT for already-watched episodes: watchCount + latest
  // date bump, one row per episode forever.
  async function rewatchEpisodes(eps: Episode[]) {
    await recordEpisodeRewatch(tmdbId, eps);
    await refreshWatchedAndEpisodes();
  }

  /**
   * Which season numbers strictly before `beforeSeason` still need
   * catching up. A season already fully watched (verifiable because it's
   * cached) is excluded, so accepting an already-caught-up show doesn't
   * nag about seasons you've already marked. A season that's never been
   * opened/cached at all is included rather than skipped: we can't verify
   * it's already watched, and the common real case (per the exact
   * scenario this was reported against) is jumping straight to marking an
   * episode deep in the series without ever having opened Season 1, so
   * silently excluding uncached seasons would recreate the original bug.
   */
  function earlierSeasonsNeedingCatchUp(beforeSeason: number): number[] {
    return (seasonNumbers ?? []).filter((n) => {
      if (n >= beforeSeason) return false;
      const eps = episodesBySeason.get(n);
      if (!eps || eps.length === 0) return true;
      return eps.some((e) => !watchedKeys.has(e.key));
    });
  }

  async function toggleEpisodeWatched(ep: Episode) {
    if (!inLibrary) return;
    if (watchedKeys.has(ep.key)) {
      await db.watchedEpisodes.delete(ep.key);
      await refreshWatchedAndEpisodes();
      setCatchUpOffer(null);
      return;
    }
    await markEpisodesWatched([ep]);

    const seasonEps = episodesBySeason.get(ep.seasonNumber) ?? [];
    const episodesInSeason = seasonEps.filter((e) => e.episodeNumber < ep.episodeNumber && !watchedKeys.has(e.key));
    const earlierSeasonNumbers = earlierSeasonsNeedingCatchUp(ep.seasonNumber);
    setCatchUpOffer(
      episodesInSeason.length > 0 || earlierSeasonNumbers.length > 0
        ? { episodesInSeason, earlierSeasonNumbers }
        : null
    );
  }

  async function toggleSeasonWatched(seasonEpisodes: Episode[], markWatched: boolean) {
    if (!inLibrary) return;
    if (markWatched) {
      await markEpisodesWatched(seasonEpisodes);
      const thisSeason = seasonEpisodes[0]?.seasonNumber;
      const earlierSeasonNumbers = thisSeason === undefined ? [] : earlierSeasonsNeedingCatchUp(thisSeason);
      setCatchUpOffer(earlierSeasonNumbers.length > 0 ? { episodesInSeason: [], earlierSeasonNumbers } : null);
    } else {
      await db.watchedEpisodes.bulkDelete(seasonEpisodes.map((ep) => ep.key));
      await refreshWatchedAndEpisodes();
      setCatchUpOffer(null);
    }
  }

  async function acceptCatchUp() {
    if (!catchUpOffer) return;
    for (const seasonNumber of catchUpOffer.earlierSeasonNumbers) {
      await ensureSeasonCached(tmdbId, seasonNumber, seasonCounts.get(seasonNumber));
    }
    const freshEpisodes =
      catchUpOffer.earlierSeasonNumbers.length > 0
        ? await db.episodes.where("showId").equals(tmdbId).toArray()
        : [];
    const fromEarlierSeasons = freshEpisodes.filter((e) => catchUpOffer.earlierSeasonNumbers.includes(e.seasonNumber));
    await markEpisodesWatched([...catchUpOffer.episodesInSeason, ...fromEarlierSeasons]);
    setCatchUpOffer(null);
  }

  // Shared by "Add to Movies" (unwatched) and "Add & mark watched": one
  // record shape, so the two paths can't drift apart.
  function buildMovieRecord(watched: boolean, d: CoreDetails): Movie {
    return {
      tmdbId,
      title: d.name,
      posterPath: d.posterPath,
      releaseYear: d.releaseDate ? Number(d.releaseDate.slice(0, 4)) : null,
      releaseDate: d.releaseDate ?? null,
      watched,
      watchedAt: watched ? new Date().toISOString() : null,
      wantsToWatch: !watched,
      runtimeMinutes: d.runtimeMinutes ?? null,
      imdbId: d.imdbId ?? null,
      addedAt: new Date().toISOString(),
    };
  }

  async function handleAdd() {
    if (!details) return;
    if (kind === "show") {
      await db.shows.put({
        tmdbId,
        name: details.name,
        posterPath: details.posterPath,
        firstAirYear: details.releaseDate ? Number(details.releaseDate.slice(0, 4)) : null,
        status: details.status ?? "",
        addedAt: new Date().toISOString(),
        isFollowed: true,
        isArchived: false,
        lastWatchedAt: null,
        episodeRuntimeMinutes: details.episodeRuntimeMinutes ?? null,
        numberOfEpisodes: details.numberOfEpisodes ?? null,
        imdbId: details.imdbId ?? null,
      });
      await refreshWatchedAndEpisodes();
    } else {
      await db.movies.put(buildMovieRecord(false, details));
    }
    setInLibrary(true);
    setAdded(true);
  }

  /**
   * One tap from the panel instead of add -> switch to Movies -> find it
   * -> mark watched. Not in the library yet: adds it already marked
   * watched. Already in: toggles. Unmarking puts the movie back on the
   * want-to-watch list (wantsToWatch: true) rather than stranding it in
   * the library on neither list, mirroring the Home rail round trip.
   */
  async function toggleMovieWatched() {
    if (kind !== "movie" || !details) return;
    if (!inLibrary) {
      await db.movies.put(buildMovieRecord(true, details));
      setInLibrary(true);
      setAdded(true);
      setMovieWatched(true);
      return;
    }
    if (movieWatched) {
      await db.movies.update(tmdbId, { watched: false, watchedAt: null, wantsToWatch: true });
      setMovieWatched(false);
    } else {
      await db.movies.update(tmdbId, { watched: true, watchedAt: new Date().toISOString(), wantsToWatch: false });
      setMovieWatched(true);
    }
  }

  async function handleRemove() {
    if (kind === "show") {
      await db.watchedEpisodes.where("showId").equals(tmdbId).delete();
      await db.episodes.where("showId").equals(tmdbId).delete();
      await db.shows.delete(tmdbId);
    } else {
      await db.movies.delete(tmdbId);
    }
    setInLibrary(false);
    setAdded(false);
    setRemoveConfirming(false);
  }

  const episodesBySeason = new Map<number, Episode[]>();
  for (const ep of episodesInDb) {
    const list = episodesBySeason.get(ep.seasonNumber);
    if (list) list.push(ep);
    else episodesBySeason.set(ep.seasonNumber, [ep]);
  }
  for (const list of episodesBySeason.values()) list.sort((a, b) => a.episodeNumber - b.episodeNumber);

  const showsSeasonBrowser = kind === "show" && seasonNumbers !== null;

  const ratingsRowContent = details && (
    <div className="ratings-row">
      {ratings === "loading" && hasOmdbKey() && <span className="muted small">Loading ratings...</span>}
      {ratings && ratings !== "loading" && (
        <>
          {ratings.imdbRating && <span className="rating-pill">IMDb {ratings.imdbRating}</span>}
          {ratings.rottenTomatoes && <span className="rating-pill">RT {ratings.rottenTomatoes}</span>}
          {!ratings.imdbRating && !ratings.rottenTomatoes && (
            <span className="muted small">
              {ratings.rateLimited
                ? OMDB_RATE_LIMIT_MESSAGE
                : ratings.error
                  ? `OMDb: ${ratings.error}`
                  : "No ratings found for this title on OMDb."}
            </span>
          )}
        </>
      )}
      {!hasOmdbKey() && <span className="muted small">Add an OMDb key in Settings to see IMDb/RT ratings.</span>}
    </div>
  );

  const addRemoveContent = details && (
    <>
      {inLibrary ? (
        <>
          <p className="status-ok">
            {added ? `Added to your ${kind === "show" ? "Shows" : "Movies"}.` : `Already in your ${kind === "show" ? "Shows" : "Movies"}.`}
            {kind === "movie" && movieWatched
              ? movieRewatchCount > 0
                ? ` Watched ${movieRewatchCount + 1} times.`
                : " Marked as watched."
              : ""}
          </p>
          <div className="field-row">
            {kind === "movie" && (
              <button onClick={toggleMovieWatched}>{movieWatched ? "Mark unwatched" : "Mark watched"}</button>
            )}
            {kind === "movie" && movieWatched && (
              <button
                onClick={async () => {
                  await recordMovieRewatch(tmdbId);
                  setMovieRewatchCount((c) => c + 1);
                }}
              >
                Watch again
              </button>
            )}
            {!removeConfirming && (
              <button className="danger-button" onClick={() => setRemoveConfirming(true)}>
                Remove from {kind === "show" ? "Shows" : "Movies"}
              </button>
            )}
          </div>
          {removeConfirming && (
            <div className="field-row">
              <span className="muted small">
                Also deletes {kind === "show" ? "its watch history" : "its watched status"}. No undo.
              </span>
              <button className="danger-button" onClick={handleRemove}>
                Confirm remove
              </button>
              <button onClick={() => setRemoveConfirming(false)}>Cancel</button>
            </div>
          )}
        </>
      ) : (
        <div className="field-row">
          <button onClick={handleAdd}>{kind === "show" ? "Add to Shows" : "Add to Movies"}</button>
          {kind === "movie" && <button onClick={toggleMovieWatched}>Add &amp; mark watched</button>}
        </div>
      )}
    </>
  );

  const overviewContent = details && (
    <p className="overview">
      {details.overview || (ratings !== "loading" && ratings?.plot) || "No summary available."}
    </p>
  );

  // Mobile keeps the original single-column composition: ratings, then the
  // add/remove action, then overview. Desktop (below) recomposes the same
  // three pieces into its own header/sidebar/main-column layout instead of
  // duplicating this JSX.
  const bodyContent = details && (
    <>
      {ratingsRowContent}
      {addRemoveContent}
      {overviewContent}
    </>
  );

  const seasonBrowserBlock = showsSeasonBrowser && (
    <div className="season-browser">
      {!inLibrary && (
        <p className="muted small" style={{ marginBottom: 10 }}>
          Previewing seasons and episodes. Add this show to your Shows to start tracking what you've watched.
        </p>
      )}
      {catchUpOffer && (
        <div className="catch-up-offer">
          <span>
            Also mark{" "}
            {catchUpOffer.episodesInSeason.length > 0 &&
              `the ${catchUpOffer.episodesInSeason.length} episode${catchUpOffer.episodesInSeason.length === 1 ? "" : "s"} before this one in this season`}
            {catchUpOffer.episodesInSeason.length > 0 && catchUpOffer.earlierSeasonNumbers.length > 0 && " and "}
            {catchUpOffer.earlierSeasonNumbers.length > 0 &&
              `${catchUpOffer.earlierSeasonNumbers.length} earlier season${catchUpOffer.earlierSeasonNumbers.length === 1 ? "" : "s"}`}
            {" "}as watched?
          </span>
          <div className="field-row">
            <button onClick={acceptCatchUp}>Yes, catch up</button>
            <button onClick={() => setCatchUpOffer(null)}>No, just this one</button>
          </div>
        </div>
      )}
      {seasonNumbers!.map((seasonNumber) => {
        const isExpanded = expandedSeason === seasonNumber;
        const eps = episodesBySeason.get(seasonNumber) ?? [];
        const watchedCount = eps.filter((e) => watchedKeys.has(e.key)).length;
        const allWatched = eps.length > 0 && watchedCount === eps.length;

        return (
          <div key={seasonNumber} className="season-block">
            <div
              className="season-header season-toggle"
              role="button"
              tabIndex={0}
              aria-expanded={isExpanded}
              onClick={() => toggleExpand(seasonNumber)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleExpand(seasonNumber);
                }
              }}
            >
              <h3>
                <span className={`season-caret ${isExpanded ? "open" : ""}`} aria-hidden="true">
                  &#9656;
                </span>{" "}
                Season {seasonNumber}
              </h3>
              <div className="season-header-right">
                {inLibrary && eps.length > 0 && (
                  <span className="muted small">
                    {watchedCount}/{eps.length}
                  </span>
                )}
                {inLibrary && isExpanded && eps.length > 0 && (
                  <button
                    className="link-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSeasonWatched(eps, !allWatched);
                    }}
                  >
                    {allWatched ? "Mark unwatched" : "Mark watched"}
                  </button>
                )}
                {inLibrary && isExpanded && eps.length > 0 && allWatched && (
                  <button
                    className="link-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      rewatchEpisodes(eps);
                    }}
                  >
                    Watch again
                  </button>
                )}
              </div>
            </div>

            {inLibrary && eps.length > 0 && (
              <div className="season-progress">
                <span style={{ width: `${(watchedCount / eps.length) * 100}%` }} />
              </div>
            )}

            {isExpanded && (
              <>
                {loadingSeason === seasonNumber && <p className="muted small">Fetching episodes...</p>}
                <ul className="episode-list">
                  {eps.map((ep) => (
                    <li key={ep.key} className={`episode-row ${watchedKeys.has(ep.key) ? "watched" : ""}`}>
                      {ep.stillPath ? (
                        <img
                          // Still ladder, not the poster base — see tmdb.ts.
                          src={`${TMDB_STILL_BASE}${ep.stillPath}`}
                          alt=""
                          aria-hidden="true"
                          className="episode-thumb"
                          onClick={() => setOpenEpisode(ep)}
                        />
                      ) : (
                        <div
                          className="episode-thumb poster-placeholder"
                          aria-hidden="true"
                          onClick={() => setOpenEpisode(ep)}
                        />
                      )}
                      <div
                        className="episode-row-body"
                        role="button"
                        tabIndex={0}
                        onClick={() => setOpenEpisode(ep)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setOpenEpisode(ep);
                          }
                        }}
                      >
                        <span className="ep-number">
                          S{ep.seasonNumber} | E{ep.episodeNumber}
                        </span>
                        <span className="ep-name">{ep.name}</span>
                      </div>
                      {inLibrary && (
                        <button
                          className={`watch-toggle ${watchedKeys.has(ep.key) ? "on" : ""}`}
                          onClick={() => toggleEpisodeWatched(ep)}
                          aria-label={watchedKeys.has(ep.key) ? "Mark unwatched" : "Mark watched"}
                          aria-pressed={watchedKeys.has(ep.key)}
                        >
                          <CheckIcon size={16} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        );
      })}
    </div>
  );

  const episodeDetailsModal = openEpisode && details && (
    <EpisodeDetailsPanel
      show={{ name: details.name, imdbId: details.imdbId }}
      episode={openEpisode}
      watched={watchedKeys.has(openEpisode.key)}
      watchCount={watchCountByKey.get(openEpisode.key) ?? 0}
      canToggleWatched={inLibrary}
      // Deliberately do NOT close on these: the panel stays open so the
      // watched toggle and the live rewatch count (+N) update in place.
      onToggleWatched={() => toggleEpisodeWatched(openEpisode)}
      onWatchAgain={() => rewatchEpisodes([openEpisode])}
      onClose={() => setOpenEpisode(null)}
    />
  );

  if (isMobile) {
    return (
      <div className="modal-backdrop sheet-backdrop" onClick={onClose}>
        <div
          ref={sheetRef}
          className={`details-sheet ${showsSeasonBrowser ? "details-modal-wide" : ""} ${
            atEnd ? "is-at-end" : ""
          }`}
          style={sheetStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sheet-drag-handle" {...handleProps}>
            <div className="sheet-drag-handle-bar" />
          </div>

          <button className="close-x hero-close-x hit-slop" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>

          <div className="sheet-scroll-area" ref={scrollAreaRef}>
            {error && (
              <div className="sheet-message" role="alert">
                <p className="status-error">{error}</p>
                <p className="muted small">
                  Your saved library still works offline; only fresh details and artwork need TMDB.
                </p>
              </div>
            )}
            {!details && !error && (
              <>
                <LoadingAnnouncement label="Loading details" />
                <DetailsSkeleton />
              </>
            )}

            {details && (
              // Hero anatomy now matches the desktop dialog: artwork behind,
              // poster and title seated together on the lower edge. The old
              // "centered" variant floated a lone title in the middle of the
              // banner whenever a backdrop existed, which left the sheet
              // looking like two unrelated designs depending on what TMDB
              // happened to have for that title.
              <>
                <div className="details-hero">
                  {details.backdropPath ? (
                    // Real horizontal image from TMDB, shown sharp, no blur needed.
                    <img
                      src={`${TMDB_BACKDROP_BASE}${details.backdropPath}`}
                      alt=""
                      className="details-hero-bg-sharp"
                    />
                  ) : (
                    // No backdrop for this title (uncommon but happens), fall back to
                    // the vertical poster, blurred since it's the wrong aspect ratio
                    // to show sharp as a wide banner.
                    details.posterPath && (
                      <div
                        className="details-hero-bg-blurred"
                        style={{ backgroundImage: `url(${TMDB_IMAGE_BASE}${details.posterPath})` }}
                      />
                    )
                  )}
                  <div className="details-hero-scrim" />
                  {details.posterPath && (
                    <img
                      src={`${TMDB_IMAGE_BASE}${details.posterPath}`}
                      alt=""
                      className="details-hero-poster"
                    />
                  )}
                  <h2 className="details-hero-title">{details.name}</h2>
                </div>

                <p className="muted small details-meta-line">
                  <MetaLine details={details} />
                </p>

                <div className="details-body">{bodyContent}</div>

                {seasonBrowserBlock}
              </>
            )}
          </div>
        </div>

        {episodeDetailsModal}
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal details-modal-desktop ${showsSeasonBrowser ? "details-modal-desktop-wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {error && (
          <div className="sheet-message" role="alert">
            <p className="status-error">{error}</p>
            <p className="muted small">
              Your saved library still works offline; only fresh details and artwork need TMDB.
            </p>
            <button type="button" onClick={onClose} style={{ alignSelf: "center", marginTop: 8 }}>
              Close
            </button>
          </div>
        )}
        {!details && !error && (
          <>
            <LoadingAnnouncement label="Loading details" />
            <DetailsSkeleton />
          </>
        )}

        {details && (
          <>
            <div className="desktop-hero">
              {details.backdropPath ? (
                <img
                  src={`${TMDB_BACKDROP_BASE}${details.backdropPath}`}
                  alt=""
                  className="details-hero-bg-sharp"
                />
              ) : (
                details.posterPath && (
                  <div
                    className="details-hero-bg-blurred"
                    style={{ backgroundImage: `url(${TMDB_IMAGE_BASE}${details.posterPath})` }}
                  />
                )
              )}
              <div className="details-hero-scrim" />
              <button className="desktop-hero-close-x hit-slop" onClick={onClose} aria-label="Close">
                <CloseIcon size={18} />
              </button>
            </div>

            <div className="desktop-header-row">
              {details.posterPath ? (
                <img src={`${TMDB_IMAGE_BASE}${details.posterPath}`} alt={details.name} className="desktop-poster-card" />
              ) : (
                <div className="poster-placeholder desktop-poster-card" />
              )}
              <div className="desktop-header-text">
                <h2>{details.name}</h2>
                <p className="muted small">
                  <MetaLine details={details} />
                </p>
              </div>
            </div>

            <div className="desktop-body">
              {ratingsRowContent}
              {addRemoveContent}
              {overviewContent}
            </div>

            {seasonBrowserBlock}
          </>
        )}
      </div>

      {episodeDetailsModal}
    </div>
  );
}