/**
 * A timestamp the way a person says it: "Today, 2:29 PM", "Yesterday, 9:05
 * AM", "Nov 15, 2:29 PM", or "Nov 15, 2025" for another year. "never" for
 * null.
 */
export function friendlyTime(iso: string | null, now = new Date()): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
