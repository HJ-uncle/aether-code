import type { JSX } from 'react'
import { AppProvider } from './core/app-context'
import { Workbench } from './workbench/Workbench'

function App(): JSX.Element {
  return (
    <AppProvider>
      <Workbench />
    </AppProvider>
  )
}

export default App
