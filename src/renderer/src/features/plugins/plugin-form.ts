import type { PluginTool } from '@renderer/core/engine/plugins'

export interface PluginFormField {
  key: string; label: string; description: string; kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json'; required: boolean
  schema: Record<string, unknown>; choices?: unknown[]
}
export type PluginFormValues = Record<string, string | boolean>
export const pluginObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
export const pluginToolTitle = (tool: PluginTool): string => typeof tool.inputSchema.title === 'string' && tool.inputSchema.title.trim() ? tool.inputSchema.title : tool.name

/** Keep arbitrary JSON Schema on the server; only plain primitive fields become native controls. */
export function pluginFormFields(tool: PluginTool): PluginFormField[] {
  const properties = pluginObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
  return Object.entries(properties).slice(0, 64).sort(([left], [right]) => Number(required.includes(right)) - Number(required.includes(left))).map(([key, value]) => {
    const schema = pluginObject(value) ? value : {}
    const choices = Array.isArray(schema.enum) && schema.enum.every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item)) ? schema.enum : undefined
    const primitive = ['string', 'number', 'integer', 'boolean'].includes(String(schema.type)) ? schema.type as 'string' | 'number' | 'integer' | 'boolean' : 'json'
    const composed = ['anyOf', 'oneOf', 'allOf', 'not', 'if'].some(name => Object.hasOwn(schema, name))
    return { key, label: typeof schema.title === 'string' && schema.title.trim() ? schema.title : key,
      description: typeof schema.description === 'string' ? schema.description : '', required: required.includes(key), schema,
      kind: composed ? 'json' : choices ? 'enum' : primitive, choices }
  })
}

export function pluginFormDefaults(fields: PluginFormField[], example: Record<string, unknown> = {}): PluginFormValues {
  return Object.fromEntries(fields.map(field => {
    const value = Object.hasOwn(example, field.key) ? example[field.key] : field.schema.default
    if (field.kind === 'boolean') return [field.key, typeof value === 'boolean' ? value : field.required ? false : '']
    if (field.kind === 'enum') return [field.key, value !== undefined ? JSON.stringify(value) : field.required && field.choices?.length ? JSON.stringify(field.choices[0]) : '']
    if (value === undefined) return [field.key, '']
    return [field.key, field.kind === 'json' ? JSON.stringify(value, null, 2) : String(value)]
  }))
}

export function parsePluginForm(fields: PluginFormField[], values: PluginFormValues): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = Object.create(null), errors: Record<string, string> = Object.create(null)
  for (const field of fields) {
    const value = values[field.key]
    if (value === '' && field.required && field.kind === 'string' && !field.schema.minLength) { args[field.key] = ''; continue }
    if (value === '' || value === undefined) { if (field.required) errors[field.key] = `请填写${field.label}`; continue }
    try {
      let parsed: unknown = value
      if (field.kind === 'number' || field.kind === 'integer') {
        const text = String(value).trim()
        if (!text || !Number.isFinite(Number(text))) throw new Error('请输入有效数字')
        parsed = Number(text)
        if (field.kind === 'integer' && !Number.isInteger(parsed)) throw new Error('请输入整数')
        if (typeof field.schema.minimum === 'number' && Number(parsed) < field.schema.minimum) throw new Error(`不能小于 ${field.schema.minimum}`)
        if (typeof field.schema.maximum === 'number' && Number(parsed) > field.schema.maximum) throw new Error(`不能大于 ${field.schema.maximum}`)
        if (typeof field.schema.exclusiveMinimum === 'number' && Number(parsed) <= field.schema.exclusiveMinimum) throw new Error(`必须大于 ${field.schema.exclusiveMinimum}`)
        if (typeof field.schema.exclusiveMaximum === 'number' && Number(parsed) >= field.schema.exclusiveMaximum) throw new Error(`必须小于 ${field.schema.exclusiveMaximum}`)
      } else if (field.kind === 'enum' || field.kind === 'json' || field.kind === 'boolean' && typeof value === 'string') parsed = JSON.parse(String(value))
      if (field.kind === 'enum' && !field.choices?.some(choice => Object.is(choice, parsed))) throw new Error('请选择可用选项')
      if (field.kind === 'boolean' && typeof parsed !== 'boolean') throw new Error('请选择开关状态')
      if (typeof parsed === 'string') {
        const length = Array.from(parsed).length
        if (typeof field.schema.minLength === 'number' && length < field.schema.minLength) throw new Error(`至少输入 ${field.schema.minLength} 个字符`)
        if (typeof field.schema.maxLength === 'number' && length > field.schema.maxLength) throw new Error(`最多输入 ${field.schema.maxLength} 个字符`)
      }
      if (field.kind === 'json' && field.schema.type === 'object' && !pluginObject(parsed)) throw new Error('请输入 JSON 对象')
      if (field.kind === 'json' && field.schema.type === 'array' && !Array.isArray(parsed)) throw new Error('请输入 JSON 数组')
      args[field.key] = parsed
    } catch (error) { errors[field.key] = error instanceof SyntaxError ? 'JSON 格式无效，请检查括号和引号' : error instanceof Error ? error.message : String(error) }
  }
  return { args, errors }
}

export function pluginValueText(value: unknown): string {
  if (value === null) return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? '—'
}

export function pluginResultTable(value: unknown): { columns: string[]; rows: Record<string, unknown>[]; total: number } | null {
  if (!Array.isArray(value) || !value.length || !value.every(pluginObject)) return null
  const rows = value.slice(0, 100), keys = [...new Set(rows.flatMap(row => Object.keys(row)))]
  // Keep a single human-readable column when every present numeric value has
  // an authored display string. The raw response still retains both values.
  const columns = keys.filter(key => !keys.includes(`${key}Text`) || !rows.some(row => typeof row[key] === 'number') || !rows.every(row => !Object.hasOwn(row, key) || typeof row[`${key}Text`] === 'string')).slice(0, 12)
  return { columns, rows, total: value.length }
}

export function pluginResultHeadlineKey(value: unknown): string | undefined {
  if (!pluginObject(value)) return undefined
  return ['formatted', 'resultText', 'display', 'expression'].find(key => typeof value[key] === 'string' && value[key])
    ?? (typeof value.unit === 'string' && value.unit.trim() && Object.values(value).some(child => pluginResultTable(child)) ? 'unit' : undefined)
}
