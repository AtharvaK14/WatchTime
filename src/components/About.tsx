import { APP_NAME } from "../appInfo";
// Official TMDB logo, rendered unmodified (color and orientation) per TMDB's
// brand terms — do not recolor it via CSS.
import tmdbLogo from "../assets/tmdb-logo.svg";

// Hosted via GitHub Pages from this repo's docs/privacy.html. This URL goes
// live once Pages is enabled (Settings → Pages → Source: main /docs).
const PRIVACY_POLICY_URL = "https://atharvak14.github.io/tv-time-replacement/privacy.html";

/**
 * About / Credits screen (Play Store prep, Phase 2). Carries the
 * attribution required to keep TMDB API access, the JustWatch credit TMDB
 * requires for watch-provider data, plus OMDb and TVmaze credits and a
 * privacy-policy link. Reachable from Settings.
 *
 * The TMDB notice text below MUST stay verbatim — it is the exact wording
 * TMDB's API Terms of Use require. Do not paraphrase it.
 */
export default function About() {
  return (
    <div className="panel">
      <div className="settings-block">
        <p className="muted small">
          {APP_NAME} is a local-first TV and movie tracker: your library and API keys live only on this device,
          with no accounts and no server. It connects directly to the services below, under your own keys, to fetch
          metadata and ratings.
        </p>
      </div>

      {/* --- TMDB: attribution required by TMDB's API Terms of Use --- */}
      <div className="settings-block about-source">
        <img src={tmdbLogo} alt="The Movie Database (TMDB)" className="about-tmdb-logo" />
        <p className="about-notice">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p className="muted small">
          Show and movie metadata, posters, and episode data from{" "}
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
            The Movie Database (TMDB)
          </a>
          .
        </p>
      </div>

      {/* --- JustWatch: attribution required for TMDB's watch-provider data.

           Separate from the TMDB block above because it is a separate
           obligation: TMDB serves the availability shown by "Available on",
           but the data behind it is JustWatch's and TMDB's terms require them
           to be credited wherever it is used. --- */}
      <div className="settings-block about-source">
        <p className="muted small">
          Streaming availability ("Available on") from{" "}
          <a href="https://www.justwatch.com" target="_blank" rel="noreferrer">
            JustWatch
          </a>
          , supplied through the TMDB API. Service names and logos are the trademarks of their respective owners;
          this app is not affiliated with, endorsed by, or certified by any of them, and shows where a title is
          listed rather than granting any access to it.
        </p>
      </div>

      {/* --- OMDb --- */}
      <div className="settings-block about-source">
        <p className="muted small">
          IMDb and Rotten Tomatoes ratings via the{" "}
          <a href="https://www.omdbapi.com" target="_blank" rel="noreferrer">
            OMDb API
          </a>{" "}
          (CC BY-NC 4.0, non-commercial use). IMDb and Rotten Tomatoes are trademarks of their respective owners;
          this app is not affiliated with, endorsed by, or certified by them.
        </p>
      </div>

      {/* --- TVmaze --- */}
      <div className="settings-block about-source">
        <p className="muted small">
          Per-episode runtimes from{" "}
          <a href="https://www.tvmaze.com" target="_blank" rel="noreferrer">
            TVmaze
          </a>
          , used under their{" "}
          <a href="https://www.tvmaze.com/api" target="_blank" rel="noreferrer">
            API terms
          </a>
          . This app is not affiliated with or endorsed by TVmaze.
        </p>
      </div>

      <hr />

      <div className="settings-block">
        <h3>Privacy</h3>
        <p className="muted small">
          No accounts, no analytics, no tracking servers. Nothing in your library leaves this device except the
          direct requests to the metadata services above, made with your own keys.
        </p>
        <p>
          <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
            Privacy policy
          </a>
        </p>
      </div>
    </div>
  );
}
