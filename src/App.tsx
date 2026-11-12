import { lazy, Suspense, useState, useEffect, useRef, type ComponentType, type CSSProperties } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { App as CapacitorApp } from "@capacitor/app";
import { db } from "./db";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Movies from "./pages/Movies";
import BackupNudge from "./components/BackupNudge";
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
import DeepLinkHost from "./components/DeepLinkHost";
import QuickActionsHost from "./components/QuickActionsHost";
import HomeMediaSwitch from "./components/HomeMediaSwitch";
import { readHomeMedia, storeHomeMedia, type HomeMedia } from "./lib/homeMedia";
import {
  initNotificationRescheduling,
  initNotificationTapHandling,
  notificationsSupported,
  syncScheduledNotifications,
} from "./lib/notifications";
import { notificationChoiceMade } from "./lib/notifications/prefs";
import NotificationPrompt from "./components/NotificationPrompt";
import { useWidgetSync } from "./lib/widget/sync";
import { useOnline } from "./lib/useOnline";
import { HomeIcon, ShowsIcon, MoviesIcon, DiscoverIcon, ForYouIcon, SettingsIcon, type IconProps } from "./components/icons";
import "./index.css";

// Screens that are not Home load as their own chunks, so the app starts by
// parsing only what the first screen needs. They are fetched in the
// background as soon as the app is idle (preloadScreens), so by the time
// anyone taps Discover, For You or Settings the code is already there.
const loadAddTitle = () => import("./pages/AddTitle");
const loadForYou = () => import("./pages/ForYouPage");
const loadSettings = () => import("./pages/Settings");
const AddTitle = lazy(loadAddTitle);
const ForYouPage = lazy(loadForYou);
const Settings = lazy(loadSettings);
// Only ever shown before a TMDB key exists.
const FirstRunWizard = lazy(() => import("./components/FirstRunWizard"));

function preloadScreens(): void {
  const run = () => {
    for (const load of [loadAddTitle, loadForYou, loadSettings]) load().catch(() => {});
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

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

/** Left-to-right position of each destination, which decides the direction a new tab slides in from. Settings sits past the last nav tab. */
const TAB_POSITION: Record<Tab, number> = { home: 0, shows: 1, movies: 2, discover: 3, forYou: 4, settings: 5 };

/** How the incoming tab enters: from the right when moving right, from the left when moving back, plain fade on launch. */
type TabDirection = "none" | "forward" | "back";

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
  // Which way the last tab change went. Derived while rendering (React's
  // "adjust state when a value changes" pattern) rather than in every one of
  // the places that call setTab: the nav, the header, Android back, Home's
  // links. The tab view is keyed on the tab, so it remounts with the new
  // direction already set and plays the matching entrance.
  const [shownTab, setShownTab] = useState<Tab>(tab);
  const [tabDirection, setTabDirection] = useState<TabDirection>("none");
  if (shownTab !== tab) {
    setShownTab(tab);
    setTabDirection(TAB_POSITION[tab] > TAB_POSITION[shownTab] ? "forward" : "back");
  }
  // The nav tab that is selected, for the sliding capsule; -1 on Settings,
  // which is not in the nav, and the capsule fades out.
  const navIndex = TAB_ORDER.indexOf(tab);
  const [moviesInitialFilter, setMoviesInitialFilter] = useState<"wantToWatch" | null>(null);
  // Home's Shows / Movies filter. Lives here rather than in Home because the
  // phone placement of the switch is rendered next to the bottom nav, outside
  // the tab view, and because Home remounts on every tab switch and the
  // choice has to outlive that. Remembered across launches.
  const [homeMedia, setHomeMediaState] = useState<HomeMedia>(readHomeMedia);
  function setHomeMedia(value: HomeMedia) {
    setHomeMediaState(value);
    storeHomeMedia(value);
  }

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

  // The notification question for an install that was never asked it: one
  // that finished onboarding before the question existed, or predates
  // onboarding altogether. New installs are asked inside the wizard instead,
  // so this waits for the wizard to close and then re-checks - by which time
  // a wizard answer is stored and this stays hidden. Android only.
  //
  // Latched in state rather than recomputed each render: saying yes stores
  // the answer BEFORE Android's dialog has been answered, and a re-render
  // reading it then would close the prompt before it could say whether
  // Android allowed them.
  const needsNotificationAnswer = () => notificationsSupported() && !notificationChoiceMade();
  const [showNotificationPrompt, setShowNotificationPrompt] = useState(() => !showOnboarding && needsNotificationAnswer());

  const [persistStatus, setPersistStatus] = useState<PersistStatus | null>(null);
  const [, forceNudgeRecheck] = useState(0);
  const online = useOnline();

  // Home-screen widgets: pushes a fresh snapshot whenever the library
  // changes and replays taps queued while the app was closed. Self-gating —
  // it costs nothing until the user actually places a widget.
  useWidgetSync();

  useEffect(() => {
    preloadScreens();
  }, []);

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

  // Notifications. Tap routing is registered unconditionally (it is inert
  // without the native shell) so a tap that cold-started the app is handled
  // even before any permission state is read. The scheduler itself no-ops
  // unless the user has both enabled the feature and granted permission, and
  // re-runs on resume so the queue tracks the library rather than drifting
  // from whatever it was when the toggle was first flipped.
  useEffect(() => {
    const cleanup = initNotificationTapHandling();
    // And whenever the library changes in a way that can make a show eligible
    // or ineligible - stopped, resumed, started, removed - not just on resume.
    const stopRescheduling = initNotificationRescheduling();
    syncScheduledNotifications().catch(() => {});
    const handle = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) syncScheduledNotifications().catch(() => {});
    });
    return () => {
      cleanup();
      stopRescheduling();
      handle.then((h) => h.remove()).catch(() => {});
    };
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
      {showOnboarding && (
        <Suspense fallback={null}>
          <FirstRunWizard
            onComplete={() => {
              setShowOnboarding(false);
              setShowNotificationPrompt(needsNotificationAnswer());
            }}
          />
        </Suspense>
      )}
      {showNotificationPrompt && <NotificationPrompt onClose={() => setShowNotificationPrompt(false)} />}

      {/* Renders the app's existing detail panels when a notification or a
          widget row is tapped. No UI of its own. */}
      <DeepLinkHost />

      {/* The one Quick Actions menu (long-press / right-click on a title,
          season or episode), the watch history sheet it opens, and the
          confirmation toasts. Portalled above every panel. */}
      <QuickActionsHost />

      <nav
        className={`side-rail${navIndex >= 0 ? " has-selection" : ""}`}
        style={{ "--nav-index": Math.max(navIndex, 0) } as CSSProperties}
      >
        {/* One capsule that slides to the selected item, rather than each
            item drawing its own: moving between tabs then reads as one
            motion from where you were to where you are. */}
        <span className="rail-indicator" aria-hidden="true" />
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

      <div className={`app-shell${tab === "home" ? " has-home-switch" : ""}`}>
        <header className="app-header">
          {/* Logo only. The app name is redundant once someone is inside
              the app, and dropping it lets the mark carry the identity at a
              size where its detail actually reads. APP_NAME is still the
              single source of truth for the launcher label and the a11y name
              here, so the wordmark leaving the header changes nothing for
              screen readers. */}
          <span className="brand" aria-label={APP_NAME}>
            <BrandMark size={44} />
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
          {/* Keyed on the tab so React remounts this wrapper on every switch,
              which is what restarts the entrance animation. The page
              components below already mounted and unmounted per tab, so this
              adds a transition without changing what is rendered or when.
              Nothing is keyed inside a page, so state within a tab is
              untouched. */}
          <div key={tab} className={`tab-view is-${tabDirection}`}>
            {tab === "home" && (
              <Home
                media={homeMedia}
                onMediaChange={setHomeMedia}
                onViewAllMovies={viewAllWantToWatchMovies}
                onOpenDiscover={() => setTab("discover")}
              />
            )}
            {tab === "shows" && <Library />}
            {tab === "movies" && (
              <Movies initialFilter={moviesInitialFilter} onInitialFilterConsumed={() => setMoviesInitialFilter(null)} />
            )}
            <Suspense fallback={null}>
              {tab === "discover" && <AddTitle />}
              {tab === "forYou" && <ForYouPage />}
              {tab === "settings" && <Settings />}
            </Suspense>
          </div>
        </main>

        {/* Home only, and phones only (CSS): docked just above the bottom nav.
            Wider screens get the inline copy Home renders beside its search. */}
        {tab === "home" && <HomeMediaSwitch value={homeMedia} onChange={setHomeMedia} placement="docked" />}

        {/* display:none above 640px via CSS, this is the mobile-only nav. */}
        <nav
          className={`bottom-nav${navIndex >= 0 ? " has-selection" : ""}`}
          style={{ "--nav-index": Math.max(navIndex, 0), "--nav-count": TAB_ORDER.length } as CSSProperties}
        >
          {/* The selected capsule, as one element that slides between tabs.
              See .nav-indicator. */}
          <span className="nav-indicator" aria-hidden="true" />
          {TAB_ORDER.map((t) => {
            const Icon = TAB_ICONS[t];
            return (
              <button
                key={t}
                className={`bottom-nav-item ${tab === t ? "active" : ""}`}
                aria-current={tab === t ? "page" : undefined}
                onClick={() => setTab(t)}
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