/** File identities: Windows LSP/explorer aliases share buffers, while POSIX casing stays distinct. */
import { expect, test } from '@playwright/test'
import { fileIdentity } from '../src/renderer/src/core/editor/file-identity'

test('Windows drive and directory casing identify the same file', () => {
  expect(fileIdentity('D:\\Workspace\\src\\Library.ts')).toBe(fileIdentity('d:/workspace/src/library.ts'))
  expect(fileIdentity('D:\\Workspace\\src\\Library.ts')).not.toBe(fileIdentity('D:/Workspace/src/Consumer.ts'))
})

test('Windows separator aliases identify the same file', () => {
  expect(fileIdentity('D:\\Workspace/src\\library.ts')).toBe(fileIdentity('D:/Workspace/src/library.ts'))
})

test('Windows UNC authority and share casing identify the same file', () => {
  expect(fileIdentity('\\\\SERVER\\Share\\src\\Library.ts')).toBe(fileIdentity('//server/share/src/library.ts'))
  expect(fileIdentity('//server/Share/library.ts')).not.toBe(fileIdentity('//server/Other/library.ts'))
})

test('POSIX file and directory casing remains distinct', () => {
  expect(fileIdentity('/workspace/src/Library.ts')).toBe('/workspace/src/Library.ts')
  expect(fileIdentity('/workspace/src/Library.ts')).not.toBe(fileIdentity('/workspace/src/library.ts'))
  expect(fileIdentity('/Workspace/src/library.ts')).not.toBe(fileIdentity('/workspace/src/library.ts'))
})
