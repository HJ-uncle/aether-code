/** D1: failed, unsupported and cancelled runs must never look like clean diagnostics. */
import { test, expect } from '@playwright/test'
import { clearFileProblems, getProblemsState, setFileDiagnosis, setFileProblems } from '../src/renderer/src/core/lsp/problems-store'
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
