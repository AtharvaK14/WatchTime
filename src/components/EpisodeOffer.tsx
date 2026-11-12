import { useState } from "react";

/**
 * The floating offer the show page makes after a mark that leaves a gap:
 *
 *  - marking an episode (or season) watched while earlier ones are not:
 *    "Mark earlier ones too?" (the catch-up offer), and
 *  - marking one not watched while later ones still are:
 *    "Unmark later ones too?" (its mirror).
 *
 * A card at the bottom of the page, in reach of the thumb, in the same shape
 * as the app's sheets: a title, one sentence saying exactly what would
 * change, and two pill buttons. It is not modal. The mark that prompted it
 * has already been saved as asked; the page behind stays usable, and the
 * next mark simply replaces or clears the offer.
 *
 * `raised` lifts it above the episode page's floating button when the mark
 * was made there.
 */
export default function EpisodeOffer({
  title,
  body,
  dismissLabel,
  actionLabel,
  destructive = false,
  raised = false,
  onDismiss,
  onAction,
}: {
  title: string;
  body: string;
  dismissLabel: string;
  actionLabel: string;
  /** The action deletes something (unmarking): its button is the red confirm. */
  destructive?: boolean;
  raised?: boolean;
  onDismiss: () => void;
  onAction: () => void | Promise<void>;
}) {
  // One accept at a time: catching up can fetch whole seasons first.
  const [working, setWorking] = useState(false);

  async function act() {
    if (working) return;
    setWorking(true);
    try {
      await onAction();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div
      className={`episode-offer${raised ? " is-raised" : ""}`}
      role="region"
      aria-label={title}
      aria-live="polite"
      onClick={(e) => e.stopPropagation()}
    >
      <h3 className="episode-offer-title">{title}</h3>
      <p className="episode-offer-body">{body}</p>
      <div className="episode-offer-actions">
        <button type="button" className="episode-offer-button" onClick={onDismiss} disabled={working}>
          {dismissLabel}
        </button>
        <button
          type="button"
          className={`episode-offer-button ${destructive ? "is-danger" : "is-primary"}`}
          onClick={act}
          aria-disabled={working}
        >
          {working ? "Working..." : actionLabel}
        </button>
      </div>
    </div>
  );
}
