import { getLastBackupAt, type NudgeReason } from "../lib/persistence";
import { CloseIcon } from "./icons";

/**
 * Non-blocking, dismissible banner shown when the library is at risk:
 * persistent storage wasn't granted, or the last backup is overdue.
 * Dismissing snoozes it for a week (handled by the caller), it doesn't
 * disable it, because the underlying risk doesn't go away.
 */
export default function BackupNudge({
  reason,
  onBackUp,
  onDismiss,
}: {
  reason: NudgeReason;
  onBackUp: () => void;
  onDismiss: () => void;
}) {
  let message: string;
  if (reason === "persist-denied") {
    message = "This device hasn't guaranteed the app's storage, it could clear your library under storage pressure.";
  } else {
    message = getLastBackupAt()
      ? "It's been over 30 days since your last backup."
      : "Your library has never been backed up.";
  }

  return (
    <div className="backup-nudge" role="status">
      <span className="backup-nudge-text">{message}</span>
      <span className="backup-nudge-actions">
        <button className="backup-nudge-cta" onClick={onBackUp}>
          Back up now
        </button>
        <button
          className="backup-nudge-dismiss hit-slop"
          onClick={onDismiss}
          aria-label="Dismiss backup reminder (it will come back in a week)"
        >
          <CloseIcon size={18} />
        </button>
      </span>
    </div>
  );
}
