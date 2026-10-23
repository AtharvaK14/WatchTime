import { useState } from "react";
import { checkTmdbKey, TMDB_API_KEY_STORAGE, type KeyCheckResult } from "../tmdb";
import { checkOmdbKey, OMDB_API_KEY_STORAGE, type OmdbKeyCheckResult } from "../omdb";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import { notificationsSupported } from "../lib/notifications";
import { notificationChoiceMade } from "../lib/notifications/prefs";
import NotificationChoice from "./NotificationChoice";

/**
 * First-run onboarding (Play Store prep, Phase 1). A stranger installing
 * this from the store has never heard of TMDB or OMDb, and the app is
 * non-functional without a TMDB key, so this walks them from zero to a
 * working state. Both steps are individually skippable with an honest
 * note about what breaks; every entered key is verified with a real API
 * call before being accepted, and failures get specific, actionable
 * messages, not a generic error.
 *
 * TVmaze deliberately has no step: it needs no key at all (it silently
 * provides per-episode runtimes), so the only mention is one line on the
 * final screen.
 *
 * Notifications are the last question, in the Android app only (the browser
 * build has nowhere to deliver them). Earlier builds never asked at all: the
 * feature started off and stayed off unless someone found the switch in
 * Settings, which on Android 13+ also meant the OS permission was never
 * requested. The step explains what they are for and lets the user choose;
 * only a yes brings up Android's permission dialog, and either answer is
 * kept, so it is not asked again. Skipping the key setup does not skip it.
 */

type Step = "welcome" | "tmdb" | "omdb" | "notifications" | "done";

type FieldStatus = "idle" | "checking" | "error";

const TMDB_ERRORS: Record<Exclude<KeyCheckResult, "valid">, string> = {
  invalid:
    'TMDB rejected this key. Make sure you pasted the "API Key" value (v3 auth) from your TMDB settings page, not the longer "API Read Access Token".',
  "network-error":
    "Couldn't reach TMDB. Check your internet connection, or try again in a minute if TMDB itself is down.",
};

const OMDB_ERRORS: Record<Exclude<OmdbKeyCheckResult, "valid" | "rate-limited">, string> = {
  invalid:
    "OMDb rejected this key. If you just signed up, you need to click the activation link in the email OMDb sent you first.",
  "network-error": "Couldn't reach OMDb. Check your internet connection, or try again in a minute.",
};

export default function FirstRunWizard({ onComplete }: { onComplete: () => void }) {
  useLockBodyScroll();
  const [step, setStep] = useState<Step>("welcome");
  // Decided once, at the start: whether this install gets the notification
  // step at all. An install that already answered (in Settings, before
  // onboarding existed) keeps its answer and is not asked again.
  const [asksNotifications] = useState(() => notificationsSupported() && !notificationChoiceMade());
  const [notificationAnswer, setNotificationAnswer] = useState<boolean | null>(null);
  // "Skip setup for now" skips the keys, not the notification question; from
  // there the wizard finishes as soon as it is answered.
  const [skippedSetup, setSkippedSetup] = useState(false);
  const totalSteps = asksNotifications ? 3 : 2;

  // Previous step for the Android back button, so back walks the wizard
  // backward instead of exiting the app mid-onboarding. Welcome has no
  // previous step (back does nothing there — onboarding is a first-run gate).
  const previousStep: Record<Step, Step | null> = {
    welcome: null,
    tmdb: "welcome",
    omdb: "tmdb",
    notifications: skippedSetup ? "welcome" : "omdb",
    done: asksNotifications ? "notifications" : "omdb",
  };
  useBackHandler(true, () => {
    const prev = previousStep[step];
    if (prev) setStep(prev);
  });

  /** Where the key steps lead once they are done or skipped. */
  const afterKeys: Step = asksNotifications ? "notifications" : "done";

  const [tmdbKey, setTmdbKey] = useState("");
  const [tmdbStatus, setTmdbStatus] = useState<FieldStatus>("idle");
  const [tmdbError, setTmdbError] = useState<string | null>(null);
  const [tmdbSaved, setTmdbSaved] = useState(false);

  const [omdbKey, setOmdbKey] = useState("");
  const [omdbStatus, setOmdbStatus] = useState<FieldStatus>("idle");
  const [omdbError, setOmdbError] = useState<string | null>(null);
  const [omdbSaved, setOmdbSaved] = useState(false);
  const [omdbNote, setOmdbNote] = useState<string | null>(null);

  function finish() {
    localStorage.setItem("onboarding_completed", "true");
    onComplete();
  }

  async function verifyTmdb() {
    setTmdbStatus("checking");
    setTmdbError(null);
    const result = await checkTmdbKey(tmdbKey.trim());
    if (result === "valid") {
      localStorage.setItem(TMDB_API_KEY_STORAGE, tmdbKey.trim());
      setTmdbSaved(true);
      setTmdbStatus("idle");
      setStep("omdb");
    } else {
      setTmdbStatus("error");
      setTmdbError(TMDB_ERRORS[result]);
    }
  }

  async function verifyOmdb() {
    setOmdbStatus("checking");
    setOmdbError(null);
    setOmdbNote(null);
    const result = await checkOmdbKey(omdbKey.trim());
    if (result === "valid" || result === "rate-limited") {
      // A rate-limited response proves the key is real: OMDb recognized it
      // and counted it against a quota. Save it and say so plainly.
      localStorage.setItem(OMDB_API_KEY_STORAGE, omdbKey.trim());
      setOmdbSaved(true);
      setOmdbStatus("idle");
      if (result === "rate-limited") {
        setOmdbNote("This key already hit its 1,000-requests-per-day limit today, so it's valid; ratings will start appearing tomorrow.");
      }
      setStep(afterKeys);
    } else {
      setOmdbStatus("error");
      setOmdbError(OMDB_ERRORS[result]);
    }
  }

  return (
    <div className="modal-backdrop wizard-backdrop">
      <div className="modal wizard">
        {step === "welcome" && (
          <>
            <p className="wizard-step-label">Welcome</p>
            <h2>Two quick keys, then you're set</h2>
            <p>
              This app has no ads, no account, and no server. Your watch history and settings live only on this
              device.
            </p>
            <p>
              The catch: it needs data — posters, episode lists, ratings. You connect it straight to two free
              services with your own keys. The keys are stored on this device and sent only to those services,
              nowhere else.
            </p>
            <p className="muted small">
              Takes about 3 minutes total, mostly waiting for a signup email. Both steps can be skipped and done
              later in Settings.
            </p>
            <div className="wizard-actions">
              <button
                className="wizard-primary"
                onClick={() => {
                  setSkippedSetup(false);
                  setStep("tmdb");
                }}
              >
                Set up keys
              </button>
              <button
                className="link-button"
                onClick={() => {
                  if (!asksNotifications) {
                    finish();
                    return;
                  }
                  setSkippedSetup(true);
                  setStep("notifications");
                }}
              >
                Skip setup for now
              </button>
            </div>
          </>
        )}

        {step === "tmdb" && (
          <>
            <p className="wizard-step-label">Step 1 of {totalSteps} · required</p>
            <h2>TMDB — the app's core data</h2>
            <p className="muted small">
              Provides search, posters, plots, and episode lists. Without it, the app can't look up any show or
              movie.
            </p>
            <ol className="wizard-howto muted small">
              <li>
                Create a free account at{" "}
                <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer">
                  themoviedb.org/signup
                </a>
              </li>
              <li>
                Open{" "}
                <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">
                  themoviedb.org/settings/api
                </a>{" "}
                and request a key (choose "Developer", personal use)
              </li>
              <li>Copy the value labeled "API Key" and paste it here</li>
            </ol>
            <input
              type="text"
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.target.value)}
              placeholder="Paste your TMDB API key"
              autoComplete="off"
              spellCheck={false}
            />
            {tmdbError && <p className="status-error small">{tmdbError}</p>}
            <div className="wizard-actions">
              <button
                className="wizard-primary"
                onClick={verifyTmdb}
                disabled={!tmdbKey.trim() || tmdbStatus === "checking"}
              >
                {tmdbStatus === "checking" ? "Checking with TMDB..." : "Verify & continue"}
              </button>
              <button className="link-button" onClick={() => setStep("omdb")}>
                Skip — search and posters won't work until added in Settings
              </button>
            </div>
          </>
        )}

        {step === "omdb" && (
          <>
            <p className="wizard-step-label">Step 2 of {totalSteps} · recommended</p>
            <h2>OMDb — IMDb &amp; Rotten Tomatoes ratings</h2>
            <p className="muted small">
              Provides IMDb ratings everywhere, plus Rotten Tomatoes scores for movies (RT doesn't publish scores
              for TV episodes through any free service — that's an upstream limitation, not this app). Free tier:
              1,000 lookups a day, plenty for normal use.
            </p>
            <ol className="wizard-howto muted small">
              <li>
                Request a free key at{" "}
                <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noreferrer">
                  omdbapi.com/apikey.aspx
                </a>{" "}
                (pick the FREE tier)
              </li>
              <li>Click the activation link in the email they send you — the key doesn't work until you do</li>
              <li>Paste the key here</li>
            </ol>
            <input
              type="text"
              value={omdbKey}
              onChange={(e) => setOmdbKey(e.target.value)}
              placeholder="Paste your OMDb API key"
              autoComplete="off"
              spellCheck={false}
            />
            {omdbError && <p className="status-error small">{omdbError}</p>}
            <div className="wizard-actions">
              <button
                className="wizard-primary"
                onClick={verifyOmdb}
                disabled={!omdbKey.trim() || omdbStatus === "checking"}
              >
                {omdbStatus === "checking" ? "Checking with OMDb..." : "Verify & continue"}
              </button>
              <button className="link-button" onClick={() => setStep(afterKeys)}>
                Skip — no IMDb or Rotten Tomatoes ratings without it
              </button>
            </div>
          </>
        )}

        {step === "notifications" && (
          <NotificationChoice
            stepLabel={skippedSetup ? "Notifications · optional" : `Step 3 of ${totalSteps} · optional`}
            onDone={(enabled) => {
              setNotificationAnswer(enabled);
              if (skippedSetup) finish();
              else setStep("done");
            }}
          />
        )}

        {step === "done" && (
          <>
            <p className="wizard-step-label">All set</p>
            <h2>
              {tmdbSaved
                ? omdbSaved
                  ? "Everything's connected"
                  : "Core setup done"
                : "You can finish this later"}
            </h2>
            {omdbNote && <p className="small">{omdbNote}</p>}
            <ul className="wizard-summary muted small">
              <li>TMDB: {tmdbSaved ? "connected" : "skipped — add it in Settings to enable search and posters"}</li>
              <li>OMDb: {omdbSaved ? "connected" : "skipped — no IMDb/RT ratings until added in Settings"}</li>
              <li>Episode runtimes come from TVmaze automatically — it needs no key.</li>
              {notificationAnswer !== null && (
                <li>
                  Notifications: {notificationAnswer ? "on" : "off"} — change them any time in Settings → Notifications
                </li>
              )}
            </ul>
            <p className="muted small">
              Coming from TV Time? Settings → Import brings your whole history over. And once your library is in,
              Settings → Backup &amp; Restore keeps it safe.
            </p>
            <div className="wizard-actions">
              <button className="wizard-primary" onClick={finish}>
                Start using the app
              </button>
              {!tmdbSaved && (
                <button className="link-button" onClick={() => setStep("tmdb")}>
                  Back to TMDB setup
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
