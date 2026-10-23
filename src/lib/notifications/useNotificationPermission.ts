import { useEffect, useState } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { checkNotificationPermission, syncScheduledNotifications, type NotificationAvailability } from ".";
import { notificationsEnabled } from "./prefs";

/**
 * The OS permission, re-read whenever the app comes back to the foreground.
 *
 * The usual way back from "blocked" is the user flipping the switch in
 * Android's own settings and returning, so a value read once on mount would
 * keep saying "blocked" after they had fixed it. A grant found this way also
 * schedules straight away when the app preference is on.
 */
export function useNotificationPermission(): [
  NotificationAvailability | null,
  (availability: NotificationAvailability) => void,
] {
  const [availability, setAvailability] = useState<NotificationAvailability | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      checkNotificationPermission().then((next) => {
        if (cancelled) return;
        setAvailability(next);
        if (next === "granted" && notificationsEnabled()) syncScheduledNotifications().catch(() => {});
      });
    refresh();
    const handle = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) refresh();
    });
    return () => {
      cancelled = true;
      handle.then((h) => h.remove()).catch(() => {});
    };
  }, []);
  return [availability, setAvailability];
}
