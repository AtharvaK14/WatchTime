import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import EpisodePanelApp from './panel/EpisodePanelApp.tsx'
import QuickMarkWatched from './panel/QuickMarkWatched.tsx'
import { restoreOnFirstLaunch, type FirstLaunchRestore } from './lib/autoBackup/firstLaunch'
import { startWithRestore } from './lib/autoBackup/startup'
import { showToast } from './lib/toast'
import RestoringScreen from './components/RestoringScreen.tsx'

// Two entry points share one bundle and one origin.
//
// The normal one is the app. The other is the episode overlay a home-screen
// widget row opens (see EpisodePanelActivity): same build, same IndexedDB,
// but App is never mounted, so a widget tap shows a pop-up over the home
// screen instead of navigating into the app.
const params = new URLSearchParams(window.location.search)
const panel = params.get('wtpanel')

const root = createRoot(document.getElementById('root')!)

/**
 * If the restore has not finished by now, the app is shown anyway. The
 * restore carries on, and the screens fill in as it lands (they read the
 * database live), which beats a frozen screen if something is stuck.
 *
 * Declared before anything below runs: startApp() is called from the
 * top-level code, so a constant declared after that call is not set yet
 * when startApp reads it.
 */
const RESTORE_WAIT_MS = 30_000

if (panel === 'episode') {
  // Marks the document for the panel-only CSS: transparent page background,
  // so the activity's window shows the home screen through it.
  document.documentElement.dataset.wtpanel = 'episode'
  const showId = Number(params.get('showId'))
  const episodeKey = params.get('episodeKey') ?? ''
  // quick=1 is a widget row's tick: mark watched and close, no panel. A
  // movieId means a Movies to Watch row rather than an Up Next one.
  const movieId = Number(params.get('movieId'))
  if (params.get('quick') === '1') {
    root.render(
      <StrictMode>
        <QuickMarkWatched
          target={movieId > 0 ? { kind: 'movie', tmdbId: movieId } : { kind: 'episode', showId, episodeKey }}
        />
      </StrictMode>,
    )
  } else root.render(
    <StrictMode>
      <EpisodePanelApp
        showId={showId}
        episodeKey={episodeKey}
        // Coming Up rows pass readonly=1: an episode that has not aired yet
        // has nothing to mark. EpisodeDetailsPanel already supports this.
        canToggleWatched={params.get('readonly') !== '1'}
      />
    </StrictMode>,
  )
} else {
  void startApp()
}

async function startApp() {
  // On the first launch after a reinstall, the library Android's backup
  // brought back is loaded before the app renders, so neither an empty Home
  // nor the setup screens flash up for a library that is about to appear.
  // Everywhere else this resolves to null almost at once.
  await startWithRestore({
    restore: restoreOnFirstLaunch,
    showRestoring: () => root.render(<RestoringScreen />),
    showApp: () =>
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      ),
    onOutcome: reportRestore,
    waitMs: RESTORE_WAIT_MS,
  })
}

function reportRestore(outcome: FirstLaunchRestore) {
  if (outcome.status === 'restored') {
    const titles = outcome.shows + outcome.movies
    showToast(
      `Restored ${titles.toLocaleString()} ${titles === 1 ? 'title' : 'titles'} from your Android backup.` +
        (outcome.keysRestored ? '' : ' Enter your TMDB key to finish setting up.'),
      'ok',
      6000,
    )
  } else {
    showToast(`Couldn't restore your Android backup: ${outcome.message}`, 'error', 8000)
  }
}
