import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import './index.css'
import { bootTheme } from './components/custom-ui/ui-store/theme-store.tsx'
import { applyZoom } from './components/custom-ui/ui-store/zoom-store.ts'
import { BrowserRouter } from "react-router-dom"
import { AppRoutes } from './app-routes.tsx'
import { UpdateToast } from './components/custom-ui/update-toast/update-toast.tsx'
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

function Root() {
  const [needRefresh, setNeedRefresh] = useState(false)
  notifyNeedRefresh = () => setNeedRefresh(true)

  return (
    <BrowserRouter>
      <AppRoutes />
      {needRefresh && <UpdateToast onReload={() => updateSW(true)} />}
    </BrowserRouter>
  )
}

createRoot(document.getElementById('root')!).render(
  // <StrictMode>
    <Root />
  // </StrictMode>,
)

