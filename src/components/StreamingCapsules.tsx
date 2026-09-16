import { useEffect, useState } from "react";
import {
  getStreamingAvailability,
  type StreamingAvailability,
  type StreamingOption,
} from "../lib/streaming/providers";
import { canLaunchStreaming, openStreaming, resolveTarget } from "../lib/streaming/launch";

/**
 * "Available on" — the one streaming-availability control in the app.
 *
 * Deliberately a single component used by the show panel, the movie panel and
 * the episode panel rather than three arrangements of the same idea. An
 * episode is not separately licensed from the series it belongs to, so the
 * episode panel asks about its SHOW and gets the identical row; that is
 * inheritance of real data, not a visual copy.
 *
 * It sits below the synopsis and above nothing, which keeps the panel's
 * hierarchy as it was: artwork, title and metadata, synopsis, availability,
 * then the existing actions.
 *
 * Everything about it is additive. No availability data, no TMDB key, no
 * network — it renders nothing and the panel above it is exactly the panel
 * that shipped before.
 */

/**
 * How many capsules the row shows before collapsing the rest behind a count.
 *
 * A popular film can be on a dozen services. Wrapping all of them turns a
 * one-line footnote into a wall that pushes the actions off screen, which
 * inverts the hierarchy the panel is built around — so the row shows the ones
 * that matter (TMDB returns them in the region's own popularity order) and
 * keeps the rest one tap away in place, rather than truncating and pretending
 * they do not exist.
 *
 * Three rather than four from measuring it: at 375px, with the 44px touch
 * sizing the app applies to every control, four capsules of realistic width
 * ("Amazon Prime Video" alone is 172px) run to three wrapped rows, which is a
 * block rather than a footnote. Three plus the count keeps it to two.
 */
const VISIBLE_LIMIT = 3;

function accessNote(access: StreamingOption["access"]): string | null {
  // Only said when it is a qualification. "Included with your subscription" is
  // what a bare capsule already implies, so saying it would be noise; "you
  // have to pay for this one" is not implied and has to be said.
  if (access === "rent") return "Rent";
  if (access === "buy") return "Buy";
  return null;
}

function Capsule({ option, title, link }: { option: StreamingOption; title: string; link: string | null }) {
  const [failed, setFailed] = useState(false);
  const target = resolveTarget(option.brand, title, link);
  const note = accessNote(option.access);
  // Where there is nowhere to send the user, or no way to send them, the
  // capsule still SHOWS - the availability is the information - it just is not
  // a control. Better than a button that does nothing when tapped.
  const openable = !!target && canLaunchStreaming();

  async function handleClick() {
    if (!target) return;
    setFailed(false);
    const outcome = await openStreaming(target);
    setFailed(outcome === "failed");
  }

  return (
    <button
      type="button"
      className="stream-capsule"
      onClick={handleClick}
      disabled={!openable}
      // Says where the tap actually lands rather than implying a title-level
      // deep link nobody can build: TMDB gives no per-service URL for a title,
      // so most services are opened at their search for it (see registry.ts).
      title={
        option.brand
          ? option.brand.precision === "search"
            ? `Find ${title} on ${option.name}`
            : `Open ${option.name}`
          : `See where to watch ${title}`
      }
    >
      {option.logoUrl && <img src={option.logoUrl} alt="" aria-hidden="true" className="stream-capsule-logo" />}
      <span className="stream-capsule-name">{option.name}</span>
      {note && <span className="stream-capsule-note">{note}</span>}
      {failed && <span className="sr-only">Could not open {option.name}</span>}
    </button>
  );
}

export default function StreamingCapsules({
  kind,
  tmdbId,
  title,
}: {
  kind: "show" | "movie";
  /** For an episode this is the SHOW's id: availability belongs to the series. */
  tmdbId: number;
  /** Used to build the service's own link for this title. The show's name for an episode. */
  title: string;
}) {
  const [availability, setAvailability] = useState<StreamingAvailability | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAvailability(null);
    setExpanded(false);
    async function load() {
      try {
        const result = await getStreamingAvailability(kind, tmdbId);
        if (!cancelled) setAvailability(result);
      } catch {
        // No key, no network, or TMDB refusing. Availability is an enhancement
        // and the panel says nothing rather than showing an error for it; the
        // things the user opened the panel for are all still there.
        if (!cancelled) setAvailability(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [kind, tmdbId]);

  if (!availability) return null;

  const { options, link, region, availableElsewhere } = availability;

  if (options.length === 0) {
    // Only worth a line when TMDB actually knows about this title elsewhere:
    // "not here" is information, "we have nothing at all" is just absence and
    // is left unsaid.
    if (!availableElsewhere) return null;
    return (
      <div className="stream-row">
        <span className="stream-row-label">Available on</span>
        <span className="muted small">Not streaming in {region}.</span>
      </div>
    );
  }

  const visible = expanded ? options : options.slice(0, VISIBLE_LIMIT);
  const hidden = options.length - visible.length;

  return (
    <div className="stream-row">
      <span className="stream-row-label">Available on</span>
      <div className="stream-capsules">
        {visible.map((option) => (
          <Capsule key={option.key} option={option} title={title} link={link} />
        ))}
        {hidden > 0 && (
          <button type="button" className="stream-capsule stream-capsule-more" onClick={() => setExpanded(true)}>
            +{hidden} more
          </button>
        )}
      </div>
    </div>
  );
}
