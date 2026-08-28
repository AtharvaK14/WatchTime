import { useEffect, useState } from "react";
import {
  cancelAllNotifications,
  checkNotificationPermission,
  mustUseSystemSettings,
  notificationsSupported,
  requestNotificationPermission,
  syncScheduledNotifications,
  type NotificationAvailability,
} from "../lib/notifications";
import type { NotificationKind } from "../lib/notifications/events";
import {
  DEFAULT_NOTIFICATION_HOUR,
  getNotificationHour,
  kindEnabled,
  notificationsEnabled,
  NOTIFICATION_KIND_LABELS,
  setKindEnabled,
  setNotificationHour,
  setNotificationsEnabled,
} from "../lib/notifications/prefs";

const KINDS: NotificationKind[] = ["episode", "season-premiere", "movie-theatrical", "movie-digital"];

function formatHour(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}${suffix}`;
}

/**
 * The only place the OS notification permission is ever requested.
 *
 * The permission is asked for on an explicit tap of the toggle and nowhere
 * else - never at launch, never on first run. Android 13+ requires
 * POST_NOTIFICATIONS at runtime and shows its dialog exactly once, so asking
 * before the user has expressed any interest spends the single chance the app
 * gets, and a reflexive "deny" then closes the feature off permanently.
 */
export default function NotificationSettings() {
  const [availability, setAvailability] = useState<NotificationAvailability | null>(null);
  const [enabled, setEnabled] = useState(() => notificationsEnabled());
  const [hour, setHour] = useState(() => getNotificationHour());
  // Mirrored into state so the checkboxes re-render; localStorage stays the
  // source of truth, matching how the stale-days threshold is handled.
  const [kinds, setKinds] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(KINDS.map((k) => [k, kindEnabled(k)]))
  );
  const [scheduled, setScheduled] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    checkNotificationPermission().then(setAvailability);
  }, []);

  async function reschedule() {
    setScheduled(await syncScheduledNotifications());
  }

  async function toggleEnabled() {
    if (enabled) {
      setNotificationsEnabled(false);
      setEnabled(false);
      setScheduled(null);
      await cancelAllNotifications();
      return;
    }

    setBusy(true);
    const result = await requestNotificationPermission();
    setAvailability(result);
    if (result === "granted") {
      setNotificationsEnabled(true);
      setEnabled(true);
      await reschedule();
    }
    setBusy(false);
  }

  function toggleKind(kind: NotificationKind) {
    const next = !kinds[kind];
    setKindEnabled(kind, next);
    setKinds((prev) => ({ ...prev, [kind]: next }));
    if (enabled) reschedule();
  }

  function changeHour(value: number) {
    setHour(value);
    setNotificationHour(value);
    if (enabled) reschedule();
  }

  if (!notificationsSupported()) {
    return (
      <div className="settings-block">
        <h3>Notifications</h3>
        <p className="muted small">
          Release notifications are only available in the Android app. The browser build has no scheduler to hand
          them to.
        </p>
      </div>
    );
  }

  const blocked = availability !== null && mustUseSystemSettings(availability);

  return (
    <>
      <div className="settings-block">
        <h3>Notifications</h3>
        <p className="muted small">
          Tells you when something in <em>your library</em> arrives: a new episode, a season premiere, a movie
          reaching cinemas, or a movie becoming available at home. Nothing else is ever announced — there are no
          recommendations here, and a title you have not added can never trigger one.
        </p>

        <div className="field-row">
          <button onClick={toggleEnabled} disabled={busy || (blocked && !enabled)}>
            {enabled ? "Turn notifications off" : busy ? "Asking..." : "Turn notifications on"}
          </button>
          {enabled && <span className="status-ok small">On</span>}
        </div>

        {blocked && !enabled && (
          <p className="muted small">
            Notifications are blocked for {""}
            <strong>this app</strong> in Android settings. Android only ever shows its permission dialog once, so
            this has to be re-enabled from{" "}
            <strong>Settings &rsaquo; Apps &rsaquo; WatchTime &rsaquo; Notifications</strong>. Come back here
            afterwards and turn them on.
          </p>
        )}

        {scheduled !== null && (
          <p className="muted small">
            {scheduled === 0
              ? "Nothing to announce in the next few weeks. This updates itself as new air dates arrive."
              : `${scheduled} upcoming release${scheduled === 1 ? "" : "s"} queued.`}
          </p>
        )}
      </div>

      {enabled && (
        <div className="settings-block">
          <h3>What to be told about</h3>
          {KINDS.map((kind) => (
            <label key={kind} className="field-row" style={{ gap: 10, marginBottom: 6 }}>
              <input type="checkbox" checked={kinds[kind]} onChange={() => toggleKind(kind)} />
              <span>{NOTIFICATION_KIND_LABELS[kind]}</span>
            </label>
          ))}

          <div className="field-row" style={{ marginTop: 12 }}>
            <label htmlFor="notification-hour">Deliver at</label>
            <select
              id="notification-hour"
              value={hour}
              onChange={(e) => changeHour(Number(e.target.value))}
              style={{ minWidth: 120 }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </div>
          <p className="muted small">
            Everything releasing on a given day is announced at this time, rather than at whatever minute a
            broadcaster happens to air. Default is {formatHour(DEFAULT_NOTIFICATION_HOUR)}.
          </p>
        </div>
      )}
    </>
  );
}
