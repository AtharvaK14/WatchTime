import { TMDB_IMAGE_BASE, type CastMember } from "../tmdb";

/**
 * The Cast row on the details and episode pages: photo cards in a row that
 * scrolls sideways, each opening that person's page. Renders nothing when
 * TMDB lists nobody.
 *
 * The person page itself is rendered by the page that owns this row, as a
 * sibling of its .details-page rather than inside it: that element carries a
 * transform while it slides or is dragged, which would pin a fixed child to
 * it instead of to the screen.
 */
export default function CastRail({
  cast,
  onOpenPerson,
}: {
  cast: CastMember[];
  onOpenPerson: (person: CastMember) => void;
}) {
  if (cast.length === 0) return null;
  return (
    <section className="cast-section" aria-label="Cast">
      <h3 className="details-section-title">Cast</h3>
      <ul className="cast-rail">
        {cast.map((person) => (
          <li key={person.id} className="cast-card">
            <button type="button" className="cast-open" onClick={() => onOpenPerson(person)}>
              {person.profilePath ? (
                <img src={`${TMDB_IMAGE_BASE}${person.profilePath}`} alt="" className="cast-photo" loading="lazy" />
              ) : (
                <span className="cast-photo cast-photo-empty" aria-hidden="true" />
              )}
              <span className="cast-name">{person.name}</span>
              {person.character && <span className="cast-role">{person.character}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
