import type { JSX } from 'react'
import { AppProvider } from './core/app-context'
import { Workbench } from './workbench/Workbench'
import { ConfirmDialogHost } from './workbench/ConfirmDialog'
import { DivergedStrategyDialogHost } from './contrib/git/DivergedStrategyDialog'

function App(): JSX.Element {
  return (
    <AppProvider>
      <Workbench />
      <ConfirmDialogHost />
      <DivergedStrategyDialogHost />
    </AppProvider>
  )
}

export default App
