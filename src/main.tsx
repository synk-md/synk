import { createRoot } from 'react-dom/client'
import './index.css'
import { bootTheme } from './components/custom-ui/ui-store/theme-store.tsx'
import { applyZoom } from './components/custom-ui/ui-store/zoom-store.ts'
import { BrowserRouter } from "react-router-dom"
import { AppRoutes } from './app-routes.tsx'
import { registerSW } from 'virtual:pwa-register'

bootTheme();
applyZoom();

// No onNeedRefresh handler: an update installs in the background and takes
// over once every tab is closed, rather than reloading someone mid-edit.
registerSW();

createRoot(document.getElementById('root')!).render(
  // <StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  // </StrictMode>,
)

