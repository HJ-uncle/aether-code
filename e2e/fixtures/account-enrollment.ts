import type { Page } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AccountState } from '../../src/shared/account'

// Playwright loads these TypeScript specs through CommonJS. A native dynamic import preserves the fixture's import.meta.url.
const source = pathToFileURL(resolve(__dirname, '../../scripts/diagnostics/fixture-account.mjs')).href
type Enrollment = {
  fixtureEnrollment(database: string): Promise<string>
  registerFixtureAccount(page: Page, database?: string): Promise<AccountState>
}
const enrollment = (): Promise<Enrollment> => import(source)
export async function fixtureEnrollment(database: string): Promise<string> {
  return (await enrollment()).fixtureEnrollment(database)
}
export async function registerFixtureAccount(page: Page, database?: string): Promise<AccountState> {
  return (await enrollment()).registerFixtureAccount(page, database)
}
