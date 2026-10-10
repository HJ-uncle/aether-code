import { expect, test } from '@playwright/test'
import { PtyLifecycle, type PtyExit } from '../src/main/terminal/pty-lifecycle'
import type { TerminalCleanupError } from '../src/shared/ipc'

class FakePty {
  killCount = 0
  private exits: Array<(event: PtyExit) => void> = []
  private cleanups: Array<(event: { cleanupError?: TerminalCleanupError }) => void> = []
  onExit(listener: (event: PtyExit) => void): { dispose: () => void } {
    this.exits.push(listener)
    return { dispose: () => { this.exits = this.exits.filter(item => item !== listener) } }
  }
  onCleanup(listener: (event: { cleanupError?: TerminalCleanupError }) => void): { dispose: () => void } {
    this.cleanups.push(listener)
    return { dispose: () => { this.cleanups = this.cleanups.filter(item => item !== listener) } }
  }
  kill(): void { this.killCount++ }
  exit(event: PtyExit = { exitCode: 0 }): void { for (const listener of [...this.exits]) listener(event) }
  cleanupError(error: TerminalCleanupError): void { for (const listener of [...this.cleanups]) listener({ cleanupError: error }) }
}

test.describe('PTY lifecycle close contract', () => {
  test('concurrent close shares one kill and waits for exit before cleanup', async () => {
    const pty = new FakePty()
    let cleaned = false
    const lifecycle = new PtyLifecycle(pty, () => { cleaned = true }, () => undefined, 500)
    const first = lifecycle.close()
    const second = lifecycle.close()
    expect(first).toBe(second)
    await expect.poll(() => pty.killCount).toBe(1)
    expect(cleaned).toBe(false)
    pty.exit()
    await first
    expect(cleaned).toBe(true)
  })

  test('cleanup failure remains observable and allows a bounded retry', async () => {
    const pty = new FakePty()
    const failure: TerminalCleanupError = { code: 'PTY_CLEANUP_FAILED', message: 'worker close failed', errors: [{ phase: 'worker', code: 'E_WORKER', name: 'Error', message: 'worker close failed' }] }
    let cleanups = 0
    const lifecycle = new PtyLifecycle(pty, () => { cleanups++ }, () => undefined, 500)
    const closing = lifecycle.close()
    await expect.poll(() => pty.killCount).toBe(1)
    pty.cleanupError(failure)
    pty.exit()
    await expect(closing).rejects.toThrow('PTY_CLEANUP_FAILED')
    expect(cleanups).toBe(0)
    await expect(lifecycle.close()).rejects.toThrow('PTY_CLEANUP_FAILED')
    expect(cleanups).toBe(0)
    expect(pty.killCount).toBe(1)
  })

  test('exit timeout does not clean profile or pretend success', async () => {
    const pty = new FakePty()
    let cleaned = false
    const lifecycle = new PtyLifecycle(pty, () => { cleaned = true }, () => undefined, 20)
    await expect(lifecycle.close()).rejects.toThrow('PTY_EXIT_TIMEOUT')
    expect(cleaned).toBe(false)
    expect(pty.killCount).toBe(1)
  })
})
