import { lazy } from 'react'

export const LazyAgentManager = lazy(() => import('./AgentManager').then(module => ({ default: module.AgentManager })))
