/** Pure policy contracts: explicit modes, crash fallback and material capability limits. */
import { expect, test } from '@playwright/test'
import {
  defaultGraphicsMode,
  isGraphicsMode,
  isVisualEffects,
  resolveVisualEffects,
  shouldUseHardware
} from '../src/shared/graphics'

test('Windows compatibility survives migration until acceleration is explicitly selected', () => {
  expect(defaultGraphicsMode('win32')).toBe('software')
  expect(defaultGraphicsMode('darwin')).toBe('auto')
  expect(defaultGraphicsMode('linux')).toBe('auto')
})

test('automatic graphics uses hardware and retains bounded recovery until an explicit retry', () => {
  const recovery = {
    reason: 'gpu-process-failed' as const,
    at: '2026-10-12T00:00:00Z',
    exitCode: -1
  }
  expect(shouldUseHardware('auto', null)).toBe(true)
  expect(shouldUseHardware('auto', recovery)).toBe(false)
  expect(shouldUseHardware('enabled', recovery)).toBe(true)
  expect(shouldUseHardware('software', null)).toBe(false)
  expect(shouldUseHardware('auto', { reason: 'startup-interrupted', at: recovery.at })).toBe(false)
})
test('diagnostic overrides win without accepting other truthy strings', () => {
  expect(shouldUseHardware('enabled', null, '0')).toBe(false)
  expect(shouldUseHardware('software', null, '1')).toBe(true)
  expect(shouldUseHardware('software', null, 'true')).toBe(false)
})
test('every software and reduced transparency preference resolves to opaque material', () => {
  for (const preference of ['auto', 'full', 'reduced', 'solid'] as const) {
    expect(resolveVisualEffects(preference, false, false)).toBe('solid')
    expect(resolveVisualEffects(preference, true, true)).toBe('solid')
  }
  expect(resolveVisualEffects('auto', true, false)).toBe('reduced')
  expect(resolveVisualEffects('full', true, false)).toBe('full')
  expect(resolveVisualEffects('reduced', true, false)).toBe('reduced')
})
test('invalid persisted or IPC preference values are rejected', () => {
  for (const value of [null, '', true, {}, 'force', 'AUTO']) {
    expect(isGraphicsMode(value)).toBe(false)
    expect(isVisualEffects(value)).toBe(false)
  }
  expect(isGraphicsMode('auto')).toBe(true)
  expect(isVisualEffects('solid')).toBe(true)
})
