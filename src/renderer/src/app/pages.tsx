import { lazy } from 'react'

// Management surfaces are loaded only when opened. Their state stays in domain stores.
export { LazyAgentManager as AgentManager } from '../features/agents/LazyAgentManager'
export const PluginManager = lazy(() => import('../features/plugins/PluginManager').then(module => ({ default: module.PluginManager })))
export const Projects = lazy(() => import('../features/projects/Projects').then(module => ({ default: module.Projects })))
export const EngineMonitorView = lazy(() => import('../features/monitoring/EngineMonitorView').then(module => ({ default: module.EngineMonitorView })))
export const AutomationsView = lazy(() => import('../features/automations/AutomationsView').then(module => ({ default: module.AutomationsView })))
