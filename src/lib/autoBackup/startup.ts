// The order of the first screens at launch, when a restore may be needed.
//
// Kept apart from main.tsx, with the rendering passed in, so the ordering can
// be checked without a device (scripts/check-backup.ts). The rule it keeps:
// once the app is on screen, nothing replaces it. The first device test broke
// exactly that - the wait timer fired at once, the app rendered, and the
// restore then put its "Restoring" screen over it for good.

export interface StartupSteps<Outcome> {
  /** Runs the restore. Calls onRestoring when it is about to write, and resolves to null when there was nothing to do. */
  restore: (onRestoring: () => void) => Promise<Outcome | null>;
  /** Shows the "Restoring your library" screen. */
  showRestoring: () => void;
  /** Shows the app. Called exactly once. */
  showApp: () => void;
  /** Reports a finished restore, after the app is on screen. */
  onOutcome: (outcome: Outcome) => void;
  /** How long a restore may hold the app back before it is shown anyway. */
  waitMs: number;
}

/**
 * Shows the app once the restore is done, or after waitMs, whichever comes
 * first. A restore still running then carries on: the app reads the database
 * live, so the library fills in as it lands, and the outcome is still
 * reported when it finishes.
 */
export async function startWithRestore<Outcome>(steps: StartupSteps<Outcome>): Promise<void> {
  let appShown = false;
  const showApp = () => {
    if (appShown) return;
    appShown = true;
    steps.showApp();
  };

  const timer = setTimeout(showApp, steps.waitMs);
  let outcome: Outcome | null = null;
  try {
    outcome = await steps.restore(() => {
      if (!appShown) steps.showRestoring();
    });
  } catch {
    // The restore reports its own failures as an outcome; a throw here is
    // unexpected, and the app is shown regardless.
  }
  clearTimeout(timer);
  showApp();
  if (outcome !== null) steps.onOutcome(outcome);
}
