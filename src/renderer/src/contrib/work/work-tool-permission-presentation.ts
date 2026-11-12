import type { PendingInteraction } from '../../core/engine/pending'
import type { PermissionPresentation, PermissionSection } from './work-permission-presentation'
import { permissionValueNode, permissionValueTree } from './work-permission-value-tree'

type Data = Record<string, unknown>
const record = (value: unknown): Data | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : undefined
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const labels: Record<string, string> = {
  command: '命令', cmd: '命令', script: '脚本', args: '参数', path: '路径', file: '文件', filePath: '文件路径', file_path: '文件路径',
  cwd: '工作目录', workdir: '工作目录', workingDirectory: '工作目录', source: '来源', target: '目标', destination: '目标路径',
  url: '网址', method: '请求方法', id: 'ID', name: '名称'
}
const fileTools = new Set(['read_file', 'write_file', 'edit_file', 'delete_file', 'create_dir'])

function scalar(value: unknown): string | undefined {
  if (value === null) return 'null'
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) || '（空）' : undefined
}
function appendValue(presentation: PermissionPresentation, id: string, label: string, value: unknown, code = false): void {
  presentation.sections.push(typeof value === 'string'
    ? { id, label, text: value, ...(code ? { code: true } : {}) }
    : { id, label, tree: [permissionValueNode(label, value)] })
}

/** High-frequency builtin parameters are recognized only for their exact tool names. */
export function appendToolPresentation(presentation: PermissionPresentation, pending: PendingInteraction): void {
  const args = record(pending.args) ?? {}, consumed = new Set<string>()
  const takeField = (key: string, label: string, format: (value: unknown) => string | undefined = scalar): void => {
    if (!Object.hasOwn(args, key)) return
    const value = format(args[key])
    if (value === undefined) return
    consumed.add(key)
    presentation.fields.push({ label, value })
  }
  const takeSection = (key: string, id: string, label: string, code = false): void => {
    if (!Object.hasOwn(args, key)) return
    consumed.add(key)
    appendValue(presentation, id, label, args[key], code)
  }
  const boolean = (value: unknown): string | undefined => typeof value === 'boolean' ? value ? '是' : '否' : undefined
  const milliseconds = (value: unknown): string | undefined => typeof value === 'number' ? `${value} 毫秒` : undefined
  if (pending.toolName === 'execute_cmd') {
    presentation.kind = 'tool'
    if (typeof args.command === 'string') {
      consumed.add('command')
      presentation.sections.push({ id: 'command', label: '程序', text: args.command, code: true })
    }
    if (Object.hasOwn(args, 'args')) {
      consumed.add('args')
      // argv is not a shell command: keep each original argument, including empty strings and whitespace.
      presentation.sections.push(strings(args.args)
        ? { id: 'command-arguments', label: '启动参数', items: [...args.args], code: true, ...(!args.args.length ? { text: '无参数' } : {}) }
        : { id: 'command-arguments', label: '启动参数', tree: [permissionValueNode('args', args.args)] })
    }
    takeField('cwd', '工作目录')
    takeField('timeoutMs', '超时', milliseconds)
    takeField('background', '运行方式', value => typeof value === 'boolean' ? value ? '后台运行' : '前台运行' : undefined)
  } else if (fileTools.has(pending.toolName)) {
    presentation.kind = 'tool'
    takeField('path', pending.toolName === 'create_dir' ? '目录路径' : '文件路径')
    if (['read_file', 'write_file'].includes(pending.toolName) && Object.hasOwn(args, 'files')) {
      consumed.add('files')
      const files = args.files
      presentation.sections.push({ id: 'files', label: pending.toolName === 'write_file' ? '批量写入' : '批量读取',
        tree: Array.isArray(files) ? files.map((file, index) => {
          const node = permissionValueNode(`文件 ${index + 1}`, file)
          const fileLabels: Record<string, string> = { path: '文件路径', data: '写入内容', content: '写入内容（content）', copyFrom: '复制来源', expectedHash: '文件版本', createOnly: '仅新建', trailingNewline: '尾部换行' }
          if (node.children) node.children = node.children.map(child => ({ ...child, label: Object.hasOwn(fileLabels, child.label) ? fileLabels[child.label] : child.label }))
          return node
        }) : [permissionValueNode('files', files)] })
    }
    if (pending.toolName === 'read_file') {
      takeField('mode', '读取方式')
      takeField('start_line', '起始行')
      takeField('end_line', '结束行')
      takeField('start_column', '起始列')
    }
    if (pending.toolName === 'write_file' || pending.toolName === 'edit_file')
      takeField('expectedHash', '文件版本', value => value === 'missing' ? '要求文件不存在' : scalar(value))
    if (pending.toolName === 'write_file') {
      takeField('createOnly', '仅新建', boolean)
      takeField('trailingNewline', '尾部换行', value => {
        if (typeof value !== 'string') return undefined
        const endings: Record<string, string> = { preserve: '保持原样', LF: 'LF', CRLF: 'CRLF', none: '无尾部换行' }
        return Object.hasOwn(endings, value) ? endings[value] : value
      })
      takeSection('copyFrom', 'copy-source', '复制来源')
      takeSection('data', 'write-content', '写入内容', true)
      takeSection('content', 'write-content-alias', '写入内容（content）', true)
    }
    if (pending.toolName === 'edit_file' && Object.hasOwn(args, 'edits')) {
      consumed.add('edits')
      if (Array.isArray(args.edits) && args.edits.length) {
        args.edits.forEach((value, index) => {
          const edit = record(value)
          const section: PermissionSection = { id: `edit-${index + 1}`, label: `修改 ${index + 1}` }
          if (edit && typeof edit.oldText === 'string' && typeof edit.newText === 'string') {
            section.previous = edit.oldText
            section.text = edit.newText
            section.code = true
            const other = Object.fromEntries(Object.entries(edit).filter(([key]) => !['oldText', 'newText'].includes(key)))
            if (Object.keys(other).length) section.tree = permissionValueTree(other)
          } else section.tree = [permissionValueNode(`修改 ${index + 1}`, value)]
          presentation.sections.push(section)
        })
      } else appendValue(presentation, 'file-edits', '修改内容', args.edits)
    }
    if (pending.toolName === 'delete_file') {
      presentation.destructive = true
      presentation.confirmLabel = '移入回收站'
      presentation.sections.push({ id: 'file-operation', label: '操作说明', text: '将文件移入系统回收站。' })
    }
    if (pending.toolName === 'create_dir')
      presentation.sections.push({ id: 'file-operation', label: '操作说明', text: '创建指定目录及缺少的父目录。' })
  } else if (pending.toolName === 'http_request') {
    presentation.kind = 'tool'
    takeField('url', '网址')
    takeField('method', '请求方法')
    takeField('timeout', '超时', value => value === 0 ? '不限时' : milliseconds(value))
    takeField('followRedirects', '跟随重定向', boolean)
    takeField('responseType', '响应格式')
    takeSection('headers', 'http-headers', '请求头')
    takeSection('body', 'http-body', '请求内容', true)
    takeSection('auth', 'http-auth', '认证信息')
  }

  const extra: Data = Object.create(null)
  let commandCount = presentation.sections.some(section => section.id === 'command') ? 1 : 0
  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key)) continue
    const label = Object.hasOwn(labels, key) ? labels[key] : undefined, formatted = scalar(value)
    if (!label || formatted === undefined) { extra[key] = value; continue }
    if (['command', 'cmd', 'script'].includes(key) && typeof value === 'string') {
      commandCount += 1
      presentation.sections.push({ id: commandCount === 1 ? 'command' : `command-${commandCount}`, label, text: value, code: true })
    } else if (typeof value === 'string' && (value.length > 180 || /[\r\n]/.test(value)))
      appendValue(presentation, key, label, value)
    else presentation.fields.push({ label, value: formatted })
  }
  if (Object.keys(extra).length)
    presentation.sections.push({ id: 'arguments', label: '其他参数', tree: permissionValueTree(extra) })
}
