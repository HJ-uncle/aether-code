import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from '../../shared/browser'
import { validateSettings } from './validation'

/** A separate file avoids turning browser cookies/settings into engine configuration. */
export class BrowserSettingsStore {
  private cache: BrowserSettings | undefined

  get(): BrowserSettings {
    if (!this.cache) {
      try {
        this.cache = validateSettings(DEFAULT_BROWSER_SETTINGS, JSON.parse(readFileSync(this.path(), 'utf8')) as Partial<BrowserSettings>)
      } catch { this.cache = { ...DEFAULT_BROWSER_SETTINGS } }
    }
    return structuredClone(this.cache)
  }

  update(patch: Partial<BrowserSettings>): BrowserSettings {
    const next = validateSettings(this.get(), patch)
    const file = this.path()
    const temporary = `${file}.${process.pid}.tmp`
    mkdirSync(app.getPath('userData'), { recursive: true })
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8')
      renameSync(temporary, file)
    } catch (error) {
      try { rmSync(temporary, { force: true }) } catch { /* preserve the storage error */ }
      throw error
    }
    this.cache = next
    return this.get()
  }

  private path(): string { return join(app.getPath('userData'), 'browser-settings.json') }
}
