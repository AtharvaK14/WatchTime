import { useState, useEffect, useRef, type ComponentType } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Movies from "./pages/Movies";
import AddTitle from "./pages/AddTitle";
import ForYouPage from "./pages/ForYouPage";
import Settings from "./pages/Settings";
import BackupNudge from "./components/BackupNudge";
import FirstRunWizard from "./components/FirstRunWizard";
import BrandMark from "./components/BrandMark";
import { hasApiKey } from "./tmdb";
import { APP_NAME } from "./appInfo";
import {
  initStoragePersistence,
  shouldShowBackupNudge,
  snoozeBackupNudge,
  BACKUP_COMPLETED_EVENT,
  type PersistStatus,
} from "./lib/persistence";
import { initNative } from "./lib/native";
import { useOnline } from "./lib/useOnline";
import { HomeIcon, ShowsIcon, MoviesIcon, DiscoverIcon, ForYouIcon, SettingsIcon, type IconProps } from "./components/icons";
import "./index.css";

type Tab = "home" | "shows" | "movies" | "discover" | "forYou" | "settings";

// Settings is deliberately NOT in the nav. It is a destination people visit
// rarely (keys, backup, import) and it was taking a slot of equal prominence
// to the content tabs; it now lives as an icon in the header. That freed slot
// goes to For You, which is content and belongs alongside the rest.
const TAB_ORDER: Tab[] = ["home", "shows", "movies", "discover", "forYou"];

const TAB_LABELS: Record<Tab, string> = {
  home: "Home",
  shows: "Shows",
  movies: "Movies",
  discover: "Discover",
  forYou: "For You",
  settings: "Settings",
};

const TAB_ICONS: Record<Tab, ComponentType<IconProps>> = {
  home: HomeIcon,
  shows: ShowsIcon,
  movies: MoviesIcon,
  discover: DiscoverIcon,
  forYou: ForYouIcon,
  settings: SettingsIcon,
};

function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [moviesInitialFilter, setMoviesInitialFilter] = useState<"wantToWatch" | null>(null);

  // Phase 0 durability: ask the browser/WebView for persistent storage once
  // per launch, and re-evaluate the backup nudge whenever a backup or
  // restore completes (the banner should clear immediately, not on reload).
  // First-run onboarding: shown only when the user has never completed or
  // skipped it AND there's no TMDB key. The hasApiKey() check grandfathers
  // in existing installs from before the wizard existed — they configured
  // keys through Settings and must never see onboarding.
  const [showOnboarding, setShowOnboarding] = useState(
    () => localStorage.getItem("onboarding_completed") !== "true" && !hasApiKey()
  );

  const [persistStatus, setPersistStatus] = useState<PersistStatus | null>(null);
  const [, forceNudgeRecheck] = useState(0);
  const online = useOnline();

  useEffect(() => {
    initStoragePersistence().then(setPersistStatus);
    const onBackupCompleted = () => forceNudgeRecheck((t) => t + 1);
    window.addEventListener(BACKUP_COMPLETED_EVENT, onBackupCompleted);
    return () => window.removeEventListener(BACKUP_COMPLETED_EVENT, onBackupCompleted);
  }, []);

  // Android hardware/gesture back button. A ref keeps the listener (set up
  // once) reading the current tab. Open overlays consume the press first
  // (they register via useBackHandler); otherwise back goes to Home, and
  // only a back press already at Home root exits the app — never from a
  // detail view or a non-Home tab.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    return initNative(() => {
      if (tabRef.current !== "home") {
        setTab("home");
        return true;
      }
      return false; // at Home root → allow exit
    });
  }, []);

  // Only nudge when there's actually a library to lose.
  const hasLibraryData = useLiveQuery(
    async () => (await db.shows.count()) > 0 || (await db.movies.count()) > 0,
    []
  );

  // Recomputed every render on purpose (it's a couple of localStorage
  // reads): its inputs change outside React, so the force-recheck state
  // above triggers the re-render when a backup completes or is snoozed.
  const nudge = shouldShowBackupNudge(persistStatus, hasLibraryData ?? false);

  function dismissNudge() {
    snoozeBackupNudge();
    forceNudgeRecheck((t) => t + 1);
  }

  function viewAllWantToWatchMovies() {
    setMoviesInitialFilter("wantToWatch");
    setTab("movies");
  }

  return (
    <>
      {showOnboarding && <FirstRunWizard onComplete={() => setShowOnboarding(false)} />}

      <nav className="side-rail">
        <span className="side-rail-mark" aria-hidden="true"><BrandMark size={22} /></span>
        {TAB_ORDER.map((t) => {
          const Icon = TAB_ICONS[t];
          return (
            <button
              key={t}
              className={`side-rail-item ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
              aria-label={TAB_LABELS[t]}
              aria-current={tab === t ? "page" : undefined}
            >
              <Icon size={22} />
            </button>
          );
        })}
      </nav>

      <div className="app-shell">
        <header className="app-header">
          {/* Logo only. The app name is redundant once someone is inside
              the app, and dropping it lets the mark carry the identity at a
              size where its detail actually reads. APP_NAME is still the
              single source of truth for the launcher label and the a11y name
              here, so the wordmark leaving the header changes nothing for
              screen readers. */}
          <span className="brand" aria-label={APP_NAME}>
            <BrandMark size={48} />
          </span>
          {/* aria-current marks it as the active page when Settings is open,
              since it is the only way in now that it has left the nav. */}
          <button
            type="button"
            className={`header-settings ${tab === "settings" ? "active" : ""}`}
            onClick={() => setTab(tab === "settings" ? "home" : "settings")}
            aria-label="Settings"
            aria-current={tab === "settings" ? "page" : undefined}
          >
            <SettingsIcon size={20} />
          </button>
        </header>

        {!online && (
          <div className="offline-banner" role="status">
            You're offline. Your library still works; search and fetching new details need a connection.
          </div>
        )}

        {nudge.show && nudge.reason && (
          <BackupNudge reason={nudge.reason} onBackUp={() => setTab("settings")} onDismiss={dismissNudge} />
        )}

        <main>
          {tab === "home" && <Home onViewAllMovies={viewAllWantToWatchMovies} />}
          {tab === "shows" && <Library />}
          {tab === "movies" && (
            <Movies initialFilter={moviesInitialFilter} onInitialFilterConsumed={() => setMoviesInitialFilter(null)} />
          )}
          {tab === "discover" && <AddTitle />}
          {tab === "forYou" && <ForYouPage />}
          {tab === "settings" && <Settings />}
        </main>

        {/* display:none above 640px via CSS, this is the mobile-only nav. */}
        <nav className="bottom-nav">
          {TAB_ORDER.map((t) => {
            const Icon = TAB_ICONS[t];
            return (
              <button
                key={t}
                className={`bottom-nav-item ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
                aria-current={tab === t ? "page" : undefined}
              >
                <Icon size={22} />
                <span>{TAB_LABELS[t]}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </>
  );
}

export default App;