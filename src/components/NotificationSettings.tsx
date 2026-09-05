import { useEffect, useState, type ComponentType } from "react";
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
  kindEnabled,
  notificationsEnabled,
  setKindEnabled,
  setNotificationsEnabled,
} from "../lib/notifications/prefs";
import { HomeIcon, SeasonsIcon, ShowsIcon, TicketIcon, type IconProps } from "./icons";

interface KindRow {
  kind: NotificationKind;
  label: string;
  /** What being on actually causes. Every row says WHEN, because "when" is no longer configurable. */
  detail: string;
  icon: ComponentType<IconProps>;
}

/**
 * The categories, grouped the way a person thinks about them rather than the
 * way the event builder happens to enumerate them.
 *
 * Labels are group-relative: inside "Movies", "Theatrical releases" says
 * everything "Movies in cinemas" did without repeating the group heading on
 * every row. This is the only place these strings live — the presentation of
 * a preference belongs with the screen that presents it, not with the
 * localStorage wrapper that stores it.
 */
const GROUPS: { title: string; rows: KindRow[] }[] = [
  {
    title: "TV shows",
    rows: [
      {
        kind: "episode",
        label: "New episodes",
        detail: "The moment an episode you follow becomes available",
        icon: ShowsIcon,
      },
      {
        kind: "season-premiere",
        label: "New seasons",
        detail: "A season premiere, or a whole season landing at once",
        icon: SeasonsIcon,
      },
    ],
  },
  {
    title: "Movies",
    rows: [
      {
        kind: "movie-theatrical",
        label: "Theatrical releases",
        detail: "When a film on your list reaches cinemas",
        icon: TicketIcon,
      },
      {
        kind: "movie-digital",
        label: "Digital releases",
        detail: "When it becomes available to watch at home",
        icon: HomeIcon,
      },
    ],
  },
];

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
  // Mirrored into state so the switches re-render; localStorage stays the
  // source of truth, matching how the stale-days threshold is handled.
  const [kinds, setKinds] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(GROUPS.flatMap((g) => g.rows).map((r) => [r.kind, kindEnabled(r.kind)]))
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

  if (!notificationsSupported()) {
    return (
      <p className="muted small">
        Release notifications are only available in the Android app. The browser build has no scheduler to hand
        them to.
      </p>
    );
  }

  const blocked = availability !== null && mustUseSystemSettings(availability);

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
        <div className="notif-groups">
          {GROUPS.map((group) => (
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
