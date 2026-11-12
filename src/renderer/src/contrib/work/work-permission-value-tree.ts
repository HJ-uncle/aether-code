import type { PermissionValueNode } from './work-permission-presentation'

/** JSON-shaped values retain their own boundaries and types; strings are never parsed as JSON. */
export function permissionValueNode(label: string, value: unknown): PermissionValueNode {
  if (Array.isArray(value))
    return { label, kind: 'array', children: value.map((item, index) => permissionValueNode(`第 ${index + 1} 项`, item)) }
  if (value !== null && typeof value === 'object')
    return { label, kind: 'object', children: permissionValueTree(value as Record<string, unknown>) }
  if (value === null) return { label, kind: 'null', value: 'null' }
  if (value === undefined) return { label, kind: 'undefined', value: '未提供' }
  const kind = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string'
  return { label, kind, value: String(value) }
}

export function permissionValueTree(value: Record<string, unknown>): PermissionValueNode[] {
  return Object.entries(value).map(([key, item]) => permissionValueNode(key, item))
}
