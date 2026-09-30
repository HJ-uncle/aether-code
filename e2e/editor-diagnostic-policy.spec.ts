/** Project tsserver must not be overridden by config-less tsc; retain independent linters. */
import { test, expect } from '@playwright/test'
import { selectEngineDiagnostics } from '../src/renderer/src/core/lsp/diagnostic-policy'
import type { ProblemItem } from '../src/renderer/src/core/lsp/problems-store'

const typeError: ProblemItem = { severity: 'error', line: 1, column: 1, source: 'typescript', code: 'TS17004', message: "Cannot use JSX unless the '--jsx' flag is provided." }
const lintWarning: ProblemItem = { severity: 'warning', line: 2, column: 1, source: 'eslint', message: 'Unused variable' }

test('project TS diagnostics take precedence while ESLint stays visible', () => {
  expect(selectEngineDiagnostics([typeError, lintWarning], true)).toEqual([lintWarning])
})

test('engine TS diagnostics remain available when project language server is unavailable', () => {
  expect(selectEngineDiagnostics([typeError, lintWarning], false)).toEqual([typeError, lintWarning])
})
