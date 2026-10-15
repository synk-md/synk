import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import './index.css'
import { bootTheme } from './components/custom-ui/ui-store/theme-store.tsx'
import { applyZoom } from './components/custom-ui/ui-store/zoom-store.ts'
import { BrowserRouter } from "react-router-dom"
import { AppRoutes } from './app-routes.tsx'
import { UpdateToast } from './components/custom-ui/update-toast/update-toast.tsx'
import { flushPersistedDocs } from './lib/yjs-utils.ts'
import { initCurrentDevice } from './lib/identity'
import { configureOwnerPins, configureRememberedEpochs, localOwnerPins, localRememberedEpochs } from './lib/workspace'
import { registerSW } from 'virtual:pwa-register'

bootTheme();
applyZoom();
// Remember each notebook's owner once established, so a rival claim cannot dispute it.
configureOwnerPins(localOwnerPins);
// And the newest epoch verified, so a timeline missing its newest record is refused.
configureRememberedEpochs(localRememberedEpochs);

// Resolved before the first render so every document created afterwards can be
// pinned to this device's client id synchronously. A failure here is reported
// and not fatal: editing locally never depended on having an identity.
const deviceReady = initCurrentDevice().catch((error: unknown) => {
  console.error('Could not load this device identity', error)
  return null
})

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

void deviceReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    // <StrictMode>
    <Root />
    // </StrictMode>,
  )
})

