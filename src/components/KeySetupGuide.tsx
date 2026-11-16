import { useState, type ReactNode } from "react";
import { APP_NAME } from "../appInfo";

/**
 * Step-by-step instructions for getting the TMDB and OMDb keys, shared by the
 * first-run wizard and Settings so the two never drift apart.
 *
 * Both sign-up forms ask what the key is for (TMDB wants an application name,
 * URL and summary; OMDb wants a "Use" description), which stops people who
 * are not developers. Each of those fields gets a ready-made honest answer
 * with a Copy button. Personal fields (name, email, address) get no sample:
 * those have to be the user's own.
 *
 * TMDB's API page answers "You don't have permission to access this page"
 * to anyone not logged in, so logging in is its own step before that link.
 */

// TMDB's form requires an Application URL, and someone using the app for
// themselves has no website. Deliberately not this project's repo: each key
// is the user's own application, and it should not name the developer's page.
const TMDB_APP_URL = "https://localhost";

const TMDB_SUMMARY =`Personal, non-commercial use. I use the ${APP_NAME} app to keep track of the TV shows and movies I watch. It looks up titles, posters and episode lists from TMDB with my own key.`;

const OMDB_USE = `Personal, non-commercial use: showing IMDb and Rotten Tomatoes ratings in ${APP_NAME}, an app I use to track the TV shows and movies I watch.`;

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** One form field: its label on the site, and what to put in it. */
function Field({ label, value, copy = true }: { label: string; value: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copyValue() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // The async clipboard API is refused in some WebViews and unfocused
      // documents; the older selection-based copy still works there.
      const scratch = document.createElement("textarea");
      scratch.value = value;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      scratch.remove();
    }
    // If both fail the value is still on screen and selectable; the button
    // just doesn't claim a copy that didn't happen.
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="key-guide-field">
      <dt>{label}</dt>
      <dd>
        <span className="key-guide-value">{value}</span>
        {copy && (
          <button type="button" className="link-button key-guide-copy" onClick={copyValue}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </dd>
    </div>
  );
}

export function TmdbKeySteps() {
  return (
    <ol className="wizard-howto muted small">
      <li>
        Create a free account at{" "}
        <ExternalLink href="https://www.themoviedb.org/signup">themoviedb.org/signup</ExternalLink> (username,
        password, email), then click the link in the verification email TMDB sends you.
      </li>
      <li>
        Log in at <ExternalLink href="https://www.themoviedb.org/login">themoviedb.org/login</ExternalLink>. Do this
        first: the next page says "You don't have permission to access this page" if you aren't logged in.
      </li>
      <li>
        Open <ExternalLink href="https://www.themoviedb.org/settings/api">themoviedb.org/settings/api</ExternalLink>{" "}
        (or tap your profile icon → Settings → API). Under "Request an API Key" follow the link, choose{" "}
        <strong>Developer</strong>, and accept the terms of use.
      </li>
      <li>
        Fill in the application form. Every field is required; these answers work:
        <dl className="key-guide-fields">
          <Field label="Type of Use" value="Personal" copy={false} />
          <Field label="Application Name" value={APP_NAME} />
          <Field label="Application URL" value={TMDB_APP_URL} />
          <Field label="Application Summary" value={TMDB_SUMMARY} />
        </dl>
        For the URL, a web page of your own (a personal site or profile) works too. The rest of the form asks for your own contact details (name, email, phone, address). Use your real ones;
        TMDB keeps them on record and doesn't contact you.
      </li>
      <li>
        Submit. The key appears right away on the same API page. Copy the 32-character value labeled{" "}
        <strong>API Key</strong>, not the much longer "API Read Access Token", and paste it below.
      </li>
      <li className="key-guide-tip">
        On a phone? TMDB's form isn't built for small screens. If it misbehaves, switch your browser to "Desktop
        site" or do this step on a computer.
      </li>
    </ol>
  );
}

export function OmdbKeySteps() {
  return (
    <ol className="wizard-howto muted small">
      <li>
        Open <ExternalLink href="https://www.omdbapi.com/apikey.aspx">omdbapi.com/apikey.aspx</ExternalLink> and
        select the account type <strong>FREE! (1,000 daily limit)</strong>. No account or password is needed.
      </li>
      <li>
        Fill in the four fields that appear. All are required:
        <dl className="key-guide-fields">
          <Field label="Email" value="Your own email address; the key is sent there" copy={false} />
          <Field label="First Name / Last Name" value="Your own name" copy={false} />
          <Field label="Use" value={OMDB_USE} />
        </dl>
      </li>
      <li>
        Press Submit. OMDb emails you the key and an activation link. It usually arrives in a minute, but Outlook,
        Hotmail and Yahoo addresses can take up to an hour; check your spam folder too.
      </li>
      <li>
        Click the activation link in that email. <strong>The key doesn't work until you do.</strong>
      </li>
      <li>Copy the key from the email and paste it below.</li>
    </ol>
  );
}
