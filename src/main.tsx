import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import EpisodePanelApp from './panel/EpisodePanelApp.tsx'

// Two entry points share one bundle and one origin.
//
// The normal one is the app. The other is the episode overlay a home-screen
// widget row opens (see EpisodePanelActivity): same build, same IndexedDB,
// but App is never mounted, so a widget tap shows a pop-up over the home
// screen instead of navigating into the app.
const params = new URLSearchParams(window.location.search)
const panel = params.get('wtpanel')

const root = createRoot(document.getElementById('root')!)

if (panel === 'episode') {
  // Marks the document for the panel-only CSS: transparent page background,
  // so the activity's window shows the home screen through it.
  document.documentElement.dataset.wtpanel = 'episode'
  root.render(
    <StrictMode>
      <EpisodePanelApp
        showId={Number(params.get('showId'))}
        episodeKey={params.get('episodeKey') ?? ''}
        // Coming Up rows pass readonly=1: an episode that has not aired yet
        // has nothing to mark. EpisodeDetailsPanel already supports this.
        canToggleWatched={params.get('readonly') !== '1'}
      />
    </StrictMode>,
  )
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
