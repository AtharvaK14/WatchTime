import { useState } from "react";
import {
  disableNotifications,
  enableNotifications,
  requestNotificationPermission,
  type NotificationAvailability,
} from "../lib/notifications";
import { useNotificationPermission } from "../lib/notifications/useNotificationPermission";
import { BlockedByAndroid } from "./NotificationSettings";
import { NOTIFICATION_GROUPS } from "./notificationGroups";

/**
 * The notification question, asked once: what notifications are for, then yes
 * or not now.
 *
 * Content only - the wizard's own step markup (label, heading, actions) - so
 * it sits inside FirstRunWizard as one of its steps, and inside the same
 * wizard card on its own for an existing install that was never asked (see
 * NotificationPrompt). Either way it looks like onboarding, not like a
 * permission dialog bolted on.
 *
 * The order is the platform's: explain first, ask the user, and only on a yes
 * show Android's permission dialog. "Not now" never touches the OS, and is
 * recorded as an answer, so nobody is asked twice. Both answers can be
 * changed in Settings > Notifications, which lists the same categories this
 * screen describes.
 */
export default function NotificationChoice({
  stepLabel,
  onDone,
}: {
  stepLabel: string;
  /** Called once the user has answered. `enabled` is their answer, not Android's. */
  onDone: (enabled: boolean) => void;
}) {
  const [availability, setAvailability] = useNotificationPermission();
  // "answered" is a yes that Android did not grant: the screen stays to say
  // so, with the way forward, instead of moving on as if it had worked.
  const [phase, setPhase] = useState<"ask" | "asking" | "answered">("ask");

  async function turnOn() {
    setPhase("asking");
    const result = await enableNotifications();
    setAvailability(result);
    if (result === "granted" || result === "unsupported") {
      onDone(true);
      return;
    }
    setPhase("answered");
  }

  async function askAgain() {
    const result: NotificationAvailability = await requestNotificationPermission();
    setAvailability(result);
  }

  async function notNow() {
    await disableNotifications();
    onDone(false);
  }

  if (phase === "answered") {
    const granted = availability === "granted";
    return (
      <>
        <p className="wizard-step-label">{stepLabel}</p>
        <h2>{granted ? "Notifications are on" : "Notifications are on in WatchTime"}</h2>
        {granted ? (
          <p className="muted small">Android now allows them too, so releases from your library will reach you.</p>
        ) : (
          availability !== null && <BlockedByAndroid availability={availability} onRequest={askAgain} />
        )}
        <div className="wizard-actions">
          <button className="wizard-primary" onClick={() => onDone(true)}>
            Continue
          </button>
          {!granted && (
            <p className="muted small">
              You can carry on without them. Settings &rsaquo; Notifications shows this again whenever you want.
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <p className="wizard-step-label">{stepLabel}</p>
      <h2>Know the moment it's out</h2>
      <p className="muted small">
        A notification when something in your library arrives - only titles you've added, nothing else.
      </p>
      <div className="wizard-notif-kinds">
        {NOTIFICATION_GROUPS.map((group) => (
          <section key={group.title} className="wizard-notif-group">
            <h3 className="notif-group-title">{group.title}</h3>
            <ul className="wizard-notif-list">
              {group.rows.map((row) => {
                const Icon = row.icon;
                return (
                  <li key={row.kind} className="wizard-notif-row">
                    <span className="notif-row-icon" aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    {/* Labels only. Under their group headings they say what
                        each one is, and the four rows plus the choice have to
                        fit a phone screen; Settings shows the full detail. */}
                    <span className="notif-row-label">{row.label}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <p className="muted small">Android will ask to allow them. Change any of this later in Settings.</p>
      <div className="wizard-actions">
        <button className="wizard-primary" onClick={turnOn} disabled={phase === "asking"}>
          {phase === "asking" ? "Waiting for Android..." : "Turn on notifications"}
        </button>
        <button className="link-button" onClick={notNow} disabled={phase === "asking"}>
          Not now
        </button>
      </div>
    </>
  );
}
