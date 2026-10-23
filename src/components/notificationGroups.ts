import type { ComponentType } from "react";
import type { NotificationKind } from "../lib/notifications/events";
import { HomeIcon, SeasonsIcon, ShowsIcon, TicketIcon, type IconProps } from "./icons";

export interface NotificationKindRow {
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
 * a preference belongs with the screens that present it (Settings' toggles
 * and the onboarding step that describes them), not with the localStorage
 * wrapper that stores it - and one list for both means what the user is told
 * in onboarding is what they find in Settings.
 */
export const NOTIFICATION_GROUPS: { title: string; rows: NotificationKindRow[] }[] = [
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
