/** Windows executable resolution: only explicitly selected absolute PATH entries may supply Git. */
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { absoluteWindowsPathEntries, findWindowsGit } from '../src/main/git/windows-git'

test('Windows Git ignores empty, relative and drive-relative PATH entries', () => {
  const selected = String.raw`C:\selected tools\Git\cmd`, network = String.raw`\\server\shared tools\Git`
  const entries = ['', '.', '..', 'tools', String.raw`C:tools`, String.raw`\tools`, '"' + selected + '"', network, '']
  expect(absoluteWindowsPathEntries(entries.join(';'))).toEqual([selected, network])
  expect(findWindowsGit(entries.slice(0, 6).join(';'))).toBeUndefined()
})

test('Windows Git uses the first real file, then the bundled fallback', ({}, info) => {
  test.skip(process.platform !== 'win32', 'resolves Windows file paths')
  const selected = info.outputPath('selected Git'), bundled = info.outputPath('installed', 'git', 'cmd')
  const invalid = info.outputPath('not a binary')
  mkdirSync(join(invalid, 'git.exe'), { recursive: true })
  for (const dir of [selected, bundled]) mkdirSync(dir, { recursive: true })
  // These are inert markers; lookup only checks file type and never executes them.
  writeFileSync(join(bundled, 'git.exe'), '')
  const entries = [invalid, selected, bundled].join(';')
  expect(findWindowsGit(entries)).toBe(join(bundled, 'git.exe'))
  writeFileSync(join(selected, 'git.exe'), '')
  expect(findWindowsGit(entries)).toBe(join(selected, 'git.exe'))
})
