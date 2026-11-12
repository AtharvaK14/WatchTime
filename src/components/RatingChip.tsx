import { StarIcon } from "./icons";
import { formatRating } from "../lib/ratings";

/**
 * The TMDB star rating in a poster's top-left corner. Renders nothing for a
 * title with no rating (never looked up, or nobody has voted on it yet).
 * Must sit inside a positioned box: the poster artwork (.card-art /
 * .mtw-poster-wrap / .rail-poster-wrap).
 */
export default function RatingChip({ rating }: { rating: number | null | undefined }) {
  const text = formatRating(rating);
  if (!text) return null;
  return (
    <span className="rating-chip">
      <StarIcon size={11} />
      <span className="sr-only">TMDB rating </span>
      {text}
    </span>
  );
}
