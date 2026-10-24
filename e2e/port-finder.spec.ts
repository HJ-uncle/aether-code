import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reserveAvailablePort } from '../src/main/engine/sdk/port-finder'

test.describe('embedded engine port allocation', () => {
  let directory: string
  let server: Server

  test.beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aether-port-'))
  })

  test.afterEach(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })

  test('skips an occupied preferred port and increments', async () => {
    server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const occupied = (server.address() as { port: number }).port
    const reservation = await reserveAvailablePort(occupied, 3, directory)
    expect(reservation.port).toBe(occupied + 1)
    await reservation.release()
  })

  test('concurrent reservations in separate starts receive different ports', async () => {
    const [first, second] = await Promise.all([
      reserveAvailablePort(0x3f20, 3, directory),
      reserveAvailablePort(0x3f20, 3, directory)
    ])
    expect(first.port).not.toBe(second.port)
    await Promise.all([first.release(), second.release()])
  })
})
