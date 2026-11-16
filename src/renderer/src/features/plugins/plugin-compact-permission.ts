import type { PendingInteraction } from '../../core/engine/pending'
import type { PermissionPresentation, PermissionValueNode } from '../interactions/permission-presentation'
import { permissionValueNode } from '../interactions/permission-value-tree'

const titles = { plugin_create: '创建插件', plugin_update: '编辑插件', plugin_publish: '发布插件', plugin_set_enabled: '启停插件' } as const
type Action = keyof typeof titles
type Data = Record<string, unknown>
const record = (value: unknown): Data | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : undefined
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const digest = (value: unknown): Data | undefined => {
  const item = record(value)
  return item && count(item.bytes) && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) ? item : undefined
}

/** Compact previews describe the sealed operation; displayed arguments are never used to execute it. */
export function compactPluginPermission(pending: PendingInteraction, base: PermissionPresentation): PermissionPresentation | undefined {
  if (!Object.hasOwn(titles, pending.toolName)) return undefined
  const action = pending.toolName as Action
  const reason = pending.question.trim().replace(/^安全策略拦截了此操作，是否允许执行？\r?\n原因：/, '')
  const match = new RegExp(`^${titles[action]}确认\\r?\\n\\r?\\n([\\s\\S]+)\\r?\\n\\r?\\n确认后执行以上操作。$`).exec(reason)
  if (!match) return undefined
  let value: Data | undefined
  try { value = record(JSON.parse(match[1])) } catch { return undefined }
  if (!value || value.action !== action || !text(value.id) || Object.hasOwn(value, 'input')) return undefined
  if (value.name !== undefined && !text(value.name) || value.version !== undefined && !text(value.version)) return undefined
  if (['plugin_update', 'plugin_publish'].includes(action) && (!count(value.expectedRevision) || value.expectedRevision < 1)) return undefined
  if (action === 'plugin_set_enabled' && typeof value.enabled !== 'boolean') return undefined
  const title = action === 'plugin_set_enabled' ? value.enabled ? '启用插件' : '停用插件' : titles[action]
  const result: PermissionPresentation = { ...base, kind: 'plugin', title, confirmLabel: title, destructive: false,
    summary: text(value.name) ? value.name : value.id, fields: [], sections: [] }
  if (text(value.version)) result.fields.push({ label: '版本', value: value.version })
  const facts = [{ label: '插件 ID', value: value.id }]
  if (count(value.expectedRevision)) facts.push({ label: '当前修订', value: String(value.expectedRevision) })
  if (action === 'plugin_publish' || action === 'plugin_set_enabled') {
    result.reason = action === 'plugin_publish' ? '发布当前草稿并启用插件。' : value.enabled ? '启用已发布的插件。' : '停用插件，停止后续调用。'
  } else {
    const changes = record(value.changes)
    if (!changes || !count(changes.added) || !count(changes.modified) || !count(changes.deleted) ||
      !count(value.changedFileCount) || value.changedFileCount !== changes.added + changes.modified + changes.deleted ||
      !count(value.omittedFileChanges) || typeof value.fileListComplete !== 'boolean') return undefined
    const files = value.files === undefined ? [] : value.files
    if (!Array.isArray(files) || files.length + value.omittedFileChanges !== value.changedFileCount ||
      value.fileListComplete !== (value.omittedFileChanges === 0)) return undefined
    const nodes: PermissionValueNode[] = []
    const entries: string[] = []
    const paths = new Set<string>()
    const observed = { added: 0, modified: 0, deleted: 0 }
    for (const item of files) {
      const file = record(item)
      if (!file || !text(file.path) || paths.has(file.path) || !['added', 'modified', 'deleted'].includes(String(file.change))) return undefined
      paths.add(file.path)
      const change = file.change as keyof typeof observed
      observed[change]++
      const before = digest(file.before), after = digest(file.after)
      if (change !== 'added' && !before || change !== 'deleted' && !after || change === 'added' && file.before !== undefined || change === 'deleted' && file.after !== undefined) return undefined
      const label = { added: '新增', modified: '修改', deleted: '删除' }[change]
      entries.push(`${label} · ${file.path} · ${before && after ? `${before.bytes} → ${after.bytes}` : String((after ?? before)!.bytes)} 字节`)
      nodes.push(permissionValueNode(file.path, {
        变更: label,
        ...(before ? { 修改前字节: before.bytes, 修改前SHA256: before.sha256 } : {}),
        ...(after ? { 修改后字节: after.bytes, 修改后SHA256: after.sha256 } : {})
      }))
    }
    if (Object.entries(observed).some(([key, total]) => total > Number(changes[key]) || value!.fileListComplete && total !== changes[key])) return undefined
    result.reason = `新增 ${changes.added} 个、修改 ${changes.modified} 个、删除 ${changes.deleted} 个文件。`
    if (count(value.fileCount)) facts.push({ label: '更新后文件', value: String(value.fileCount) })
    if (count(value.totalBytes)) facts.push({ label: '更新后大小', value: `${value.totalBytes} 字节` })
    result.sections.push({ id: 'plugin-file-changes', label: '文件变更', items: entries,
      ...(value.omittedFileChanges > 0 ? { text: `还有 ${value.omittedFileChanges} 个文件变更未在此摘要展开。` } : nodes.length ? {} : { text: '文件内容未变化。' }) })
    if (nodes.length) result.sections.push({ id: 'plugin-content-digests', label: '内容校验', tree: nodes })
    const manifest = record(value.manifest), before = digest(manifest?.before), after = digest(manifest?.after)
    if (manifest && after && Array.isArray(manifest.changedFields) && manifest.changedFields.every(text)) {
      result.sections.push({ id: 'plugin-manifest-changes', label: '清单变更',
        items: manifest.changedFields as string[], facts: [
          ...(before ? [{ label: '修改前 SHA-256', value: String(before.sha256) }] : []),
          { label: '修改后 SHA-256', value: String(after.sha256) }
        ] })
    }
  }
  result.sections.push({ id: 'plugin-details', label: '插件信息', facts })
  return result
}
