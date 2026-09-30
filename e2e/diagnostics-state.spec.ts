/** D1: failed, unsupported and cancelled runs must never look like clean diagnostics. */
import { test, expect } from '@playwright/test'
import { clearFileProblems, diagnosticFileKey, getProblemsState, setFileDiagnosis, setFileProblems, type ProblemItem } from '../src/renderer/src/core/lsp/problems-store'

test.afterEach(() => {
  const state = getProblemsState()
  for (const file of new Set([...state.byFile.keys(), ...state.diagnoses.keys()])) clearFileProblems(file)
})

const typeError: ProblemItem = {
  severity: 'error', line: 1, column: 7, code: 'TS2322',
  message: "Type 'string' is not assignable to type 'number'.", source: 'typescript'
}
const tsserverError: ProblemItem = { ...typeError, code: '2322', endLine: 1, endColumn: 18 }
test('diagnostic errors remain distinct from completed empty results, cancellation clears pending state', () => {
  const file = 'D:/synthetic-d1.ts'
  setFileProblems(file, [])
  expect(getProblemsState().diagnoses.get(file)?.status).toBe('completed')
  setFileDiagnosis(file, 'running')
  expect(getProblemsState().byFile.has(file)).toBe(false)
  setFileDiagnosis(file, 'unsupported', 'No adapter')
  expect(getProblemsState().diagnoses.get(file)).toEqual({status: 'unsupported', message: 'No adapter'})
  setFileDiagnosis(file, 'error', 'Compiler failed')
  expect(getProblemsState().diagnoses.get(file)?.status).toBe('error')
  setFileDiagnosis(file, 'running')
  setFileDiagnosis(file, 'cancelled')
  expect(getProblemsState().diagnoses.has(file)).toBe(false)
  expect(getProblemsState().byFile.has(file)).toBe(false)
  setFileDiagnosis(file, 'running')
  clearFileProblems(file)
  expect(getProblemsState().diagnoses.has(file)).toBe(false)
})

test('Windows path aliases and TypeScript code formats produce one file and one complete diagnostic', () => {
  const file = 'D:\\dev\\aether-code/.e2e-tmp/diagnostic-broken.ts'
  const alias = 'd:\\dev\\AETHER-CODE\\.e2e-tmp\\diagnostic-broken.ts'
  setFileProblems(file, [typeError])
  setFileProblems(alias, [tsserverError], 'tsserver')

  expect([...getProblemsState().byFile.keys()]).toEqual([file])
  expect(getProblemsState().byFile.get(file)).toEqual([{ ...typeError, endLine: 1, endColumn: 18 }])
  expect([...getProblemsState().diagnoses.keys()]).toEqual([file])

  clearFileProblems(alias, 'engine')
  expect(getProblemsState().byFile.get(file)).toEqual([tsserverError])
  expect(getProblemsState().diagnoses.size).toBe(0)
  clearFileProblems(alias)
  expect(getProblemsState().byFile.size).toBe(0)
})

test('engine diagnosis adopts the editor path even when tsserver arrives first and owners clear independently', () => {
  const file = 'D:\\dev\\aether-code/src/example.ts'
  const alias = 'd:/dev/aether-code/src/example.ts'
  setFileProblems(alias, [tsserverError], 'tsserver')
  setFileDiagnosis(file, 'running')
  expect([...getProblemsState().byFile.keys()]).toEqual([file])
  expect(getProblemsState().diagnoses.get(file)?.status).toBe('running')
  setFileProblems(file, [typeError])
  clearFileProblems(alias, 'tsserver')
  expect(getProblemsState().byFile.get(file)).toEqual([typeError])
  expect(getProblemsState().diagnoses.get(file)?.status).toBe('completed')
  setFileDiagnosis(alias, 'cancelled')
  expect(getProblemsState().byFile.size).toBe(0)
  expect(getProblemsState().diagnoses.size).toBe(0)
})

test('diagnostic merging preserves different sources, severities, codes and complete ranges', () => {
  const file = 'D:/semantic-diagnostics.ts'
  const complete = { ...typeError, endLine: 1, endColumn: 18 }
  const distinct: ProblemItem[] = [
    { ...complete, source: 'eslint' },
    { ...complete, severity: 'warning' },
    { ...complete, code: 'TS2345' },
    { ...complete, endColumn: 22 }
  ]
  setFileProblems(file, [complete, ...distinct])
  setFileProblems(file, [{ ...tsserverError, source: 'typescript-language-server' }], 'tsserver')
  expect(getProblemsState().byFile.get(file)).toEqual([complete, ...distinct])
})

test('Windows UNC aliases share identity while POSIX file names remain case sensitive', () => {
  const unc = '\\\\Server\\Share\\src\\file.ts'
  const alias = '//server/share/src/FILE.ts'
  expect(diagnosticFileKey(unc)).toBe(diagnosticFileKey(alias))
  setFileProblems(unc, [typeError])
  setFileProblems(alias, [tsserverError], 'tsserver')
  expect(getProblemsState().byFile.size).toBe(1)
  clearFileProblems(alias)
  setFileProblems('/project/Example.ts', [typeError])
  setFileProblems('/project/example.ts', [typeError])
  expect([...getProblemsState().byFile.keys()]).toEqual(['/project/Example.ts', '/project/example.ts'])
})
