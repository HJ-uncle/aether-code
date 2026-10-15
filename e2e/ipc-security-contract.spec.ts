/** Pure IPC security contracts: only a live main-frame sender may invoke the
 * engine bridge, and identity capture keeps delayed work bound to one engine
 * instance/account.  These tests avoid launching Electron so they stay fast. */
import { expect, test } from '@playwright/test'
import { isTrustedMainFrameBinding } from '../src/main/ipc-security'
import { engineIdentityOf } from '../src/main/engine/protocol'

test('IPC sender must be the owning window main frame', () => {
  const mainFrame = {}
  let destroyed = false
  const sender = { mainFrame, isDestroyed: () => destroyed }
  expect(isTrustedMainFrameBinding(sender, mainFrame, sender)).toBe(true)
  expect(isTrustedMainFrameBinding(sender, {}, sender)).toBe(false)
  expect(isTrustedMainFrameBinding(sender, mainFrame, {})).toBe(false)
  destroyed = true
  expect(isTrustedMainFrameBinding(sender, mainFrame, sender)).toBe(false)
})

test('engine identity capture includes instance and account fencing fields', () => {
  const identity = engineIdentityOf({
    mode: 'remote' as const,
    baseUrl: 'https://engine.example.test/',
    instanceId: 'engine-2',
    accountId: undefined
  })
  expect(identity).toEqual({ mode: 'remote', baseUrl: 'https://engine.example.test/', instanceId: 'engine-2', accountId: null })
})

