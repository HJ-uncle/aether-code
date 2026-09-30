import type { ProblemItem } from './problems-store'

/** A project tsserver owns TS semantics; a second single-file tsc cannot resolve its config. */
export function selectEngineDiagnostics(items: ProblemItem[], projectTypeScriptActive: boolean): ProblemItem[] {
  return projectTypeScriptActive ? items.filter((item) => item.source !== 'typescript') : items
}
