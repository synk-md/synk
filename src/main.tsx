import { createRoot } from 'react-dom/client'
import './index.css'
import { bootTheme } from './components/custom-ui/ui-store/theme-store.tsx'
import { BrowserRouter } from "react-router-dom"
import { AppRoutes } from './app-routes.tsx'

bootTheme();

createRoot(document.getElementById('root')!).render(
  // <StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  // </StrictMode>,
)

