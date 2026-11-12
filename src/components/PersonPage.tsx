import { useCallback, useEffect, useRef, useState } from "react";
import { getPerson, type PersonCredit, type PersonDetails } from "../tmdb";
import DetailsPanel from "./DetailsPanel";
import ExpandableText from "./ExpandableText";
import TitleCard from "./TitleCard";
import { DetailsSkeleton, PosterRailSkeleton } from "./Skeleton";
import { useAnimatedDismiss } from "../lib/useAnimatedDismiss";
import { useBackHandler } from "../lib/backHandler";
import { useIsMobile } from "../lib/useIsMobile";
import { useLibraryIds } from "../lib/useLibraryIds";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useSwipeDismiss } from "../lib/useSwipeDismiss";

/**
 * A cast member's page, opened by tapping them in a details page's Cast row:
 * their photo fading into the page, name, a line of facts, their biography,
 * then rails of the shows and movies they are in. Each title opens its own
 * details page on top, so someone can wander from a show to an actor to
 * another show and back out one layer at a time.
 *
 * Built from the details page's own parts (the same page, hero, topbar and
 * swipe-down-to-close), so it reads as one more page of the same kind.
 */

const PAGE_EXIT_MS = 240;
const DIALOG_EXIT_MS = 180;
/** TMDB profile size large enough for the full-width hero. */
const PROFILE_HERO_BASE = "https://image.tmdb.org/t/p/h632";
/** How many titles each rail shows; best known first. */
const RAIL_LIMIT = 20;

function yearOf(date: string | null): string | null {
  return date ? date.slice(0, 4) : null;
}

/** "Acting · Born 1971 in London, England" / "Directing · 1930-2020" */
function factsLine(p: PersonDetails): string {
  const parts: string[] = [];
  if (p.knownFor) parts.push(p.knownFor);
  const born = yearOf(p.birthday);
  const died = yearOf(p.deathday);
  if (born && died) parts.push(`${born}–${died}`);
  else if (born) parts.push(p.placeOfBirth ? `Born ${born} in ${p.placeOfBirth}` : `Born ${born}`);
  else if (p.placeOfBirth) parts.push(`From ${p.placeOfBirth}`);
  return parts.join(" · ");
}

export default function PersonPage({
  personId,
  name,
  profilePath,
  onClose,
}: {
  personId: number;
  /** Shown at once, from the cast row, while the full record loads. */
  name: string;
  profilePath: string | null;
  onClose: () => void;
}) {
  useLockBodyScroll();
  const isMobile = useIsMobile();
  const { closing, requestClose } = useAnimatedDismiss(onClose, isMobile ? PAGE_EXIT_MS : DIALOG_EXIT_MS);
  useBackHandler(true, requestClose);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useSwipeDismiss(pageRef, scrollRef, isMobile, requestClose);

  const [person, setPerson] = useState<PersonDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTitle, setOpenTitle] = useState<{ kind: "show" | "movie"; tmdbId: number } | null>(null);
  const library = useLibraryIds();

  useEffect(() => {
    let cancelled = false;
    getPerson(personId)
      .then((p) => !cancelled && setPerson(p))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [personId]);

  useEffect(() => {
    // A title opened from here handles its own Escape.
    if (openTitle) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, openTitle]);

  const closeTitle = useCallback(() => setOpenTitle(null), []);

  const photo = person?.profilePath ?? profilePath;

  function rail(title: string, credits: PersonCredit[]) {
    if (credits.length === 0) return null;
    const inLibrary = (c: PersonCredit) => (c.kind === "show" ? library.shows : library.movies).has(c.tmdbId);
    return (
      <section className="person-credits" aria-label={title}>
        <h3 className="details-section-title">
          {title} <span className="person-credit-count">{credits.length}</span>
        </h3>
        <div className="card-rail person-rail">
          {credits.slice(0, RAIL_LIMIT).map((c) => (
            <TitleCard
              key={`${c.kind}:${c.tmdbId}`}
              kind={c.kind}
              tmdbId={c.tmdbId}
              name={c.name}
              year={c.year}
              posterPath={c.posterPath}
              rating={c.rating}
              inLibrary={inLibrary(c)}
              onOpen={() => setOpenTitle({ kind: c.kind, tmdbId: c.tmdbId })}
            />
          ))}
        </div>
      </section>
    );
  }

  return (
    <div
      className={`details-page-root${isMobile ? " is-page" : " is-dialog"}${closing ? " is-leaving" : ""}`}
      onClick={isMobile ? undefined : requestClose}
    >
      <div
        ref={pageRef}
        className="details-page person-page"
        role="dialog"
        aria-modal="true"
        aria-label={person?.name ?? name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="details-page-scroll" ref={scrollRef}>
          <div className="details-page-hero is-poster">
            {photo ? (
              <img src={`${PROFILE_HERO_BASE}${photo}`} alt="" className="details-page-hero-img" />
            ) : (
              <div className="details-page-hero-img details-page-hero-empty" />
            )}
            <div className="details-page-hero-fade" />
          </div>

          <div className="details-page-body">
            <div className="details-page-head">
              <div>
                <h2 className="details-title">{person?.name ?? name}</h2>
                {person && factsLine(person) && <p className="details-subtitle">{factsLine(person)}</p>}
              </div>
            </div>

            {error && <p className="status-error">{error}</p>}
            {!person && !error && (
              <>
                <DetailsSkeleton />
                <PosterRailSkeleton count={5} />
              </>
            )}
            {person && (
              <>
                {person.biography && (
                  <ExpandableText className="overview" lines={4} inlineToggle text={person.biography} />
                )}
                {rail("Shows", person.shows)}
                {rail("Movies", person.movies)}
                {person.shows.length === 0 && person.movies.length === 0 && (
                  <p className="muted">TMDB lists no shows or movies for {person.name}.</p>
                )}
              </>
            )}
          </div>
        </div>

        <div className="details-page-topbar">
          <button className="details-page-icon" onClick={requestClose} aria-label="Close">
            &times;
          </button>
        </div>
      </div>

      {openTitle && (
        <DetailsPanel key={`${openTitle.kind}:${openTitle.tmdbId}`} kind={openTitle.kind} tmdbId={openTitle.tmdbId} onClose={closeTitle} />
      )}
    </div>
  );
}
