import { APP_NAME } from "../appInfo";
import { HeadingWithInfo, InfoButton } from "./Sheet";
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
          Your library and API keys stay on this device. No accounts, no server: {APP_NAME} talks directly to the
          services below with your own keys.
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
        <div className="about-credit">
          <p className="muted small">
            Streaming availability from{" "}
            <a href="https://www.justwatch.com" target="_blank" rel="noreferrer">
              JustWatch
            </a>
            , through the TMDB API.
          </p>
          <InfoButton title="JustWatch">
            <p>
              Service names and logos are the trademarks of their respective owners. This app is not affiliated with,
              endorsed by, or certified by any of them, and shows where a title is listed rather than granting any
              access to it.
            </p>
          </InfoButton>
        </div>
      </div>

      {/* --- OMDb --- */}
      <div className="settings-block about-source">
        <div className="about-credit">
          <p className="muted small">
            IMDb and Rotten Tomatoes ratings via the{" "}
            <a href="https://www.omdbapi.com" target="_blank" rel="noreferrer">
              OMDb API
            </a>{" "}
            (CC BY-NC 4.0).
          </p>
          <InfoButton title="OMDb">
            <p>
              OMDb data is licensed CC BY-NC 4.0, for non-commercial use. IMDb and Rotten Tomatoes are trademarks of
              their respective owners; this app is not affiliated with, endorsed by, or certified by them.
            </p>
          </InfoButton>
        </div>
      </div>

      {/* --- TVmaze --- */}
      <div className="settings-block about-source">
        <div className="about-credit">
          <p className="muted small">
            Episode runtimes from{" "}
            <a href="https://www.tvmaze.com" target="_blank" rel="noreferrer">
              TVmaze
            </a>
            .
          </p>
          <InfoButton title="TVmaze">
            <p>
              Used under TVmaze's{" "}
              <a href="https://www.tvmaze.com/api" target="_blank" rel="noreferrer">
                API terms
              </a>
              . This app is not affiliated with or endorsed by TVmaze.
            </p>
          </InfoButton>
        </div>
      </div>

      <div className="settings-block">
        <HeadingWithInfo
          title="Privacy"
          info={
            <>
              <p>
                No accounts, no analytics, no tracking servers. Nothing in your library leaves this device except the
                direct requests to the services above, made with your own keys. The weekly check for a newer version
                asks GitHub for the latest release and sends nothing about you or your library.
              </p>
              <p>
                On Android, a snapshot of your library is kept where the phone's own backup can take it, if you have
                that turned on in Android's settings, so a reinstall brings your library back. Your API keys go with
                it only when the phone has a screen lock, which is when Android encrypts the backup end to end.{" "}
                {APP_NAME} does not send it anywhere itself.
              </p>
            </>
          }
        />
        <p className="muted small">No accounts, analytics or tracking.</p>
        <p>
          <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
            Privacy policy
          </a>
        </p>
      </div>
    </div>
  );
}
