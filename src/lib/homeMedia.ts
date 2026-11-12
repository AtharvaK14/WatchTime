/** What Home shows: the user's TV shows, or their movies. See components/HomeMediaSwitch.tsx. */
export type HomeMedia = "shows" | "movies";

const STORAGE_KEY = "home_media";

/** The remembered choice, Shows when there is none (or storage is unavailable). */
export function readHomeMedia(): HomeMedia {
  try {
    return localStorage.getItem(STORAGE_KEY) === "movies" ? "movies" : "shows";
  } catch {
    return "shows";
  }
}

export function storeHomeMedia(value: HomeMedia): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Not remembered across launches, which is all this costs.
  }
}
