import { useState } from "react";
import {
  disableNotifications,
  enableNotifications,
  mustUseSystemSettings,
  notificationsSupported,
  openNotificationSettings,
  requestNotificationPermission,
  syncScheduledNotifications,
  type NotificationAvailability,
} from "../lib/notifications";
import type { NotificationKind } from "../lib/notifications/events";
import { kindEnabled, notificationsEnabled, setKindEnabled } from "../lib/notifications/prefs";
import { useNotificationPermission } from "../lib/notifications/useNotificationPermission";
import { NOTIFICATION_GROUPS } from "./notificationGroups";

/**
 * What to say, and offer, when the app preference is on but Android is not
 * delivering. Shared with onboarding so the two never describe the same state
 * differently. Never claims notifications are on while the OS says no.
 */
export function BlockedByAndroid({
  availability,
  onRequest,
}: {
  availability: NotificationAvailability;
  /** Asks again, for the case where Android will still show its dialog. */
  onRequest: () => void;
}) {
  const [couldNotOpen, setCouldNotOpen] = useState(false);
  if (availability === "granted" || availability === "unsupported") return null;

  if (availability === "prompt" || !mustUseSystemSettings(availability)) {
    return (
      <div className="notif-blocked">
        <p className="muted small">
          Android hasn't given WatchTime permission to show notifications yet, so none can be delivered.
        </p>
        <div className="field-row">
          <button type="button" onClick={onRequest}>
            Allow notifications
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="notif-blocked">
      <p className="muted small">
        Android is blocking notifications for <strong>WatchTime</strong>, so none can be delivered. Android won't ask
        again from inside the app; allow them in Android settings and WatchTime starts sending them, nothing else to
        do.
      </p>
      <div className="field-row">
        <button
          type="button"
          onClick={async () => {
            if (!(await openNotificationSettings())) setCouldNotOpen(true);
          }}
        >
          Open Android settings
        </button>
      </div>
      {couldNotOpen && (
        <p className="muted small">
          Couldn't open it from here. It's under{" "}
          <strong>Settings &rsaquo; Apps &rsaquo; WatchTime &rsaquo; Notifications</strong>.
        </p>
      )}
    </div>
  );
}

/**
 * Notification preferences, and the route to the OS permission.
 *
 * Two separate states, shown separately: the app preference (on or off, the
 * user's choice, made here or in onboarding) and Android's permission (which
 * only Android can grant). Notifications are delivered only when both are on,
 * and the screen says which one is missing rather than reporting "On" while
 * Android blocks them.
 *
 * The permission is only ever requested on an explicit tap - here, or yes in
 * onboarding - never at launch. Android 13+ requires POST_NOTIFICATIONS at
 * runtime and shows its dialog a limited number of times, so asking before the
 * user has expressed any interest spends the chance the app gets.
 */
export default function NotificationSettings() {
  const [availability, setAvailability] = useNotificationPermission();
  const [enabled, setEnabled] = useState(() => notificationsEnabled());
  // Mirrored into state so the switches re-render; localStorage stays the
  // source of truth, matching how the stale-days threshold is handled.
  const [kinds, setKinds] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(NOTIFICATION_GROUPS.flatMap((g) => g.rows).map((r) => [r.kind, kindEnabled(r.kind)]))
  );
  const [scheduled, setScheduled] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function reschedule() {
    setScheduled(await syncScheduledNotifications());
  }

  async function toggleEnabled() {
    if (enabled) {
      setEnabled(false);
      setScheduled(null);
      await disableNotifications();
      return;
    }

    setBusy(true);
    const result = await enableNotifications();
    setEnabled(true);
    setAvailability(result);
    if (result === "granted") await reschedule();
    setBusy(false);
  }

  async function askAgain() {
    setBusy(true);
    const result = await requestNotificationPermission();
    setAvailability(result);
    if (result === "granted") await reschedule();
    setBusy(false);
  }

  function toggleKind(kind: NotificationKind) {
    const next = !kinds[kind];
    setKindEnabled(kind, next);
    setKinds((prev) => ({ ...prev, [kind]: next }));
    if (enabled) reschedule();
  }

  if (!notificationsSupported()) {
    return (
      <p className="muted small">
        Release notifications are only available in the Android app. The browser build has no scheduler to hand
        them to.
      </p>
    );
  }

  const delivering = enabled && availability === "granted";

  return (
    <>
      {/* No heading of its own: the <summary> this sits under already says
          "Notifications", and repeating it put the same word on screen twice
          with nothing between them. */}
      <div className="settings-block">
        <p className="muted small">
          Tells you when something in <em>your library</em> arrives, as soon as it does. Nothing else is ever
          announced — there are no recommendations here, and a title you have not added can never trigger one.
        </p>

        <div className="field-row">
          <button onClick={toggleEnabled} disabled={busy}>
            {enabled ? "Turn notifications off" : busy ? "Asking..." : "Turn notifications on"}
          </button>
          {delivering && <span className="status-ok small">On</span>}
          {enabled && !delivering && availability !== null && (
            <span className="muted small">On in WatchTime, blocked by Android</span>
          )}
        </div>

        {enabled && availability !== null && <BlockedByAndroid availability={availability} onRequest={askAgain} />}

        {delivering && scheduled !== null && (
          <p className="muted small">
            {scheduled === 0
              ? "Nothing to announce in the next few weeks. This updates itself as new air dates arrive."
              : `${scheduled} upcoming release${scheduled === 1 ? "" : "s"} queued.`}
          </p>
        )}
      </div>

      {enabled && (
        <div className="notif-groups">
          {NOTIFICATION_GROUPS.map((group) => (
            <section key={group.title} className="notif-group">
              <h3 className="notif-group-title">{group.title}</h3>
              <div className="notif-list">
                {group.rows.map((row) => {
                  const Icon = row.icon;
                  const on = kinds[row.kind];
                  return (
                    <button
                      key={row.kind}
                      type="button"
                      // role="switch" rather than a checkbox: the whole row is
                      // the target, which is what makes this comfortable to hit
                      // on a phone, and aria-checked keeps the on/off state
                      // announced rather than merely drawn.
                      role="switch"
                      aria-checked={on}
                      className={`notif-row ${on ? "on" : ""}`}
                      onClick={() => toggleKind(row.kind)}
                    >
                      <span className="notif-row-icon" aria-hidden="true">
                        <Icon size={18} />
                      </span>
                      <span className="notif-row-text">
                        <span className="notif-row-label">{row.label}</span>
                        <span className="notif-row-detail">{row.detail}</span>
                      </span>
                      <span className="notif-switch" aria-hidden="true">
                        <span className="notif-switch-knob" />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
