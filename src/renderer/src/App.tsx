import type { JSX } from 'react'
import { AppProvider } from './core/app-context'
import { ApplicationShell } from './app/ApplicationShell'
import { ConfirmDialogHost } from './ui/ConfirmDialog'
import { DivergedStrategyDialogHost } from './features/git/DivergedStrategyDialog'
import { ToastHost } from './ui/ToastHost'
import { IconProvider } from './ui/icons'

function App(): JSX.Element {
  return (
    <AppProvider>
      <IconProvider variant="outline">
        <ApplicationShell />
        <ConfirmDialogHost />
        <DivergedStrategyDialogHost />
        <ToastHost />
      </IconProvider>
    </AppProvider>
  )
}

export default App
