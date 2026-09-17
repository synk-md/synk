import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import './index.css'
import { bootTheme } from './components/custom-ui/ui-store/theme-store.tsx'
import { applyZoom } from './components/custom-ui/ui-store/zoom-store.ts'
import { BrowserRouter } from "react-router-dom"
import { AppRoutes } from './app-routes.tsx'
import { UpdateToast } from './components/custom-ui/update-toast/update-toast.tsx'
import { flushPersistedDocs } from './lib/yjs-utils.ts'
import { registerSW } from 'virtual:pwa-register'

bootTheme();
applyZoom();

let notifyNeedRefresh: () => void = () => {}

// The new service worker installs and waits in the background; onNeedRefresh
// only surfaces a toast once it's ready, it never reloads on its own.
const updateSW = registerSW({
  onNeedRefresh() {
    notifyNeedRefresh()
  },
})

// updateSW(true) hands over to the waiting service worker, which reloads the
// tab as soon as it takes control. Every edit is persisted by y-indexeddb in
// its own asynchronous IndexedDB transaction, and an in-flight transaction is
// aborted when the page unloads - so wait for what's already queued to commit
// before triggering the reload.
async function flushThenReload() {
  try {
    await flushPersistedDocs()
  } catch (error) {
    console.error('Could not flush pending writes before reloading', error)
  }
  await updateSW(true)
}

function Root() {
  const [needRefresh, setNeedRefresh] = useState(false)
  notifyNeedRefresh = () => setNeedRefresh(true)

  return (
    <BrowserRouter>
      <AppRoutes />
      {needRefresh && <UpdateToast onReload={flushThenReload} />}
    </BrowserRouter>
  )
}

createRoot(document.getElementById('root')!).render(
  // <StrictMode>
    <Root />
  // </StrictMode>,
)

