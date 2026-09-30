/** 关闭决策纯逻辑：整批确认、保存失败、新输入竞态及文件路径复制语义；无需 Electron。 */
import { expect, test } from '@playwright/test'
import {
  confirmDocumentClose,
  type ClosableDocument,
  type CloseConfirmationHost
} from '../src/renderer/src/core/editor/close-confirmation'
import { relativeFilePath } from '../src/renderer/src/core/editor/file-context-actions'

function document(path: string, content = 'edited', savedContent = 'disk'): ClosableDocument {
  return { path, name: path, content, savedContent, isBinary: false }
}

function fixture(action: 'save' | 'discard' | 'cancel') {
  const documents = new Map([['a.ts', document('a.ts')], ['b.ts', document('b.ts')]])
  const saved: string[] = []
  const errors: string[] = []
  let confirmations = 0
  const host: CloseConfirmationHost = {
    read: (path) => documents.get(path),
    save: async (path) => {
      const current = documents.get(path)
      if (!current) return
      saved.push(path)
      documents.set(path, { ...current, savedContent: current.content })
    },
    confirm: async (options) => {
      confirmations++
      if (action === 'save') return await options.tertiary!.run()
      return action === 'discard'
    },
    error: (message) => errors.push(message)
  }
  return { documents, saved, errors, host, confirmations: () => confirmations }
}

test('批量关闭只确认一次，取消保留所有未保存文档且不写盘', async () => {
  const f = fixture('cancel')
  expect(await confirmDocumentClose(['a.ts', 'b.ts'], f.host)).toBe(false)
  expect(f.confirmations()).toBe(1)
  expect(f.saved).toEqual([])
  expect([...f.documents.values()].map((doc) => doc.content)).toEqual(['edited', 'edited'])
})

test('明确丢弃批准整批关闭，不隐式写盘', async () => {
  const f = fixture('discard')
  expect(await confirmDocumentClose(['a.ts', 'b.ts'], f.host)).toBe(true)
  expect(f.saved).toEqual([])
})

test('保存全部之后才批准关闭，重复路径只保存一次', async () => {
  const f = fixture('save')
  expect(await confirmDocumentClose(['a.ts', 'b.ts', 'a.ts'], f.host)).toBe(true)
  expect(f.saved).toEqual(['a.ts', 'b.ts'])
  expect([...f.documents.values()].every((doc) => doc.content === doc.savedContent)).toBe(true)
})

test('任何文件保存失败均拒绝整批关闭', async () => {
  const f = fixture('save')
  const originalSave = f.host.save
  f.host.save = async (path) => {
    if (path === 'b.ts') throw new Error('disk conflict')
    await originalSave(path)
  }
  expect(await confirmDocumentClose(['a.ts', 'b.ts'], f.host)).toBe(false)
  expect(f.saved).toEqual(['a.ts'])
  expect(f.documents.get('b.ts')?.content).toBe('edited')
  expect(f.errors).toEqual(['保存失败，文件均未关闭'])
})

test('保存等待期间的新输入不能被保存并关闭顺带丢弃', async () => {
  const f = fixture('save')
  f.host.save = async (path) => {
    const before = f.documents.get(path)!
    f.documents.set(path, { ...before, content: 'typed while saving', savedContent: before.content })
  }
  expect(await confirmDocumentClose(['a.ts'], f.host)).toBe(false)
  expect(f.documents.get('a.ts')?.content).toBe('typed while saving')
  expect(f.errors).toEqual(['保存期间又有新的修改，文件均未关闭'])
})

test('丢弃确认期间集合中的干净文件又被修改，拒绝关闭', async () => {
  const f = fixture('discard')
  f.documents.set('b.ts', document('b.ts', 'disk', 'disk'))
  f.host.confirm = async () => {
    f.documents.set('b.ts', document('b.ts', 'new edit', 'disk'))
    return true
  }
  expect(await confirmDocumentClose(['a.ts', 'b.ts'], f.host)).toBe(false)
  expect(f.errors).toEqual(['确认期间文件又有新的修改，文件均未关闭'])
})

test('仅干净文件和已关闭文件不弹确认，也不发保存请求', async () => {
  const f = fixture('cancel')
  f.documents.set('a.ts', document('a.ts', 'disk', 'disk'))
  expect(await confirmDocumentClose(['a.ts', 'missing.ts'], f.host)).toBe(true)
  expect(f.confirmations()).toBe(0)
  expect(f.saved).toEqual([])
})

test('相对路径复制兼容Windows大小写、盘符根目录和UNC', () => {
  expect(relativeFilePath('D:\\Workspace', 'd:/workspace/src/App.ts')).toBe('src/App.ts')
  expect(relativeFilePath('D:\\', 'd:/src/App.ts')).toBe('src/App.ts')
  expect(relativeFilePath('\\\\SERVER\\Share', '//server/share/src/App.ts')).toBe('src/App.ts')
  expect(relativeFilePath('D:\\Workspace', 'D:\\Workspace-other\\App.ts')).toBe('D:\\Workspace-other\\App.ts')
})

test('相对路径复制保持POSIX大小写，根自身为点，工作区外保留绝对路径', () => {
  expect(relativeFilePath('/workspace', '/workspace/src/App.ts')).toBe('src/App.ts')
  expect(relativeFilePath('/workspace', '/Workspace/src/App.ts')).toBe('/Workspace/src/App.ts')
  expect(relativeFilePath('/workspace', '/workspace')).toBe('.')
  expect(relativeFilePath('/', '/')).toBe('.')
  expect(relativeFilePath('/', '/src/App.ts')).toBe('src/App.ts')
  expect(relativeFilePath(null, '/src/App.ts')).toBe('/src/App.ts')
})
