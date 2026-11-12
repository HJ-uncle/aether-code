import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { getPluginApplication, invokePluginApplication, type PluginApplication, type PluginInvocation } from '@renderer/core/engine/plugins'
import { getEngineSource } from '@renderer/core/engine/source'
import { subscribeResourceCatalogueChanges } from '@renderer/core/engine/resource-catalogue'
import { Icon } from '@renderer/ui/icons'
import { parsePluginForm, pluginFormDefaults, pluginFormFields, pluginObject, pluginResultHeadlineKey, pluginResultTable, pluginToolTitle, pluginValueText, type PluginFormField, type PluginFormValues } from './plugin-form'
import './plugin-runner.css'

function ResultValue({ value, depth = 0 }: { value: unknown; depth?: number }): JSX.Element {
  const table = pluginResultTable(value)
  if (table) return <div className="work-plugin-app__table-wrap"><table><thead><tr>{table.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row, index) => <tr key={index}>{table.columns.map(column => <td key={column}>{pluginValueText(row[column])}</td>)}</tr>)}</tbody></table>{table.total > table.rows.length ? <p>已显示前 {table.rows.length} 项，共 {table.total} 项。完整内容见原始结果。</p> : null}</div>
  if (pluginObject(value) && depth < 2) return <dl className="work-plugin-app__values">{Object.entries(value).slice(0, 64).map(([key, child]) => <div key={key}><dt>{key}</dt><dd>{pluginObject(child) || Array.isArray(child) ? <ResultValue value={child} depth={depth + 1} /> : pluginValueText(child)}</dd></div>)}</dl>
  if (Array.isArray(value) && value.length <= 100) return <ul>{value.map((item, index) => <li key={index}>{pluginValueText(item)}</li>)}</ul>
  return <span>{pluginValueText(value)}</span>
}

function InvocationResult({ output }: { output: PluginInvocation }): JSX.Element {
  const result = output.result
  const headline = pluginResultHeadlineKey(result)
  const expression = pluginObject(result) && headline !== 'expression' && typeof result.expression === 'string' ? result.expression : ''
  const note = pluginObject(result) && typeof result.note === 'string' ? result.note : ''
  const remaining = pluginObject(result) ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== headline && key !== 'note' && (!expression || key !== 'expression'))) : result
  const tables = headline && pluginObject(remaining) ? Object.entries(remaining).filter(([, value]) => pluginResultTable(value)) : []
  const details = headline && pluginObject(remaining) ? Object.fromEntries(Object.entries(remaining).filter(([key]) => !tables.some(([name]) => name === key))) : remaining
  return <section className="work-plugin-app__result" aria-label="插件运行结果" aria-live="polite">
    <div className="work-plugin-app__result-heading"><h2>结果</h2><span>{output.durationMs} ms · r{output.plugin.revision}</span></div>
    {headline && pluginObject(result) ? <p className="work-plugin-app__headline">{String(result[headline])}</p> : null}
    {expression ? <p className="work-plugin-app__expression">{expression}</p> : null}
    {note ? <p className="work-plugin-app__result-note">{note}</p> : null}
    {tables.map(([key, value]) => <div key={key}><h3>{key}</h3><ResultValue value={value} /></div>)}
    {headline ? pluginObject(details) && Object.keys(details).length ? <details><summary>计算详情</summary><ResultValue value={details} /></details> : null : <ResultValue value={details} />}
    {output.artifacts.length ? <div className="work-plugin-app__artifacts"><h3>文件预览</h3><p>以下内容尚未写入工作区。</p>{output.artifacts.map((artifact, index) => <details key={index}><summary>{artifact.path}</summary>{artifact.encoding === 'base64' ? <p>二进制文件内容见原始结果。</p> : <pre>{artifact.content}</pre>}</details>)}</div> : null}
    <details className="work-plugin-app__raw"><summary>原始结果</summary><pre>{JSON.stringify(output, null, 2)}</pre></details>
  </section>
}

function Field({ field, value, error, disabled, prefix, onChange }: { field: PluginFormField; value: string | boolean; error?: string; disabled: boolean; prefix: string; onChange: (value: string | boolean) => void }): JSX.Element {
  const id = `${prefix}-${encodeURIComponent(field.key)}`, help = `${id}-help`, alert = `${id}-error`
  const common = { id, 'aria-label': field.label, 'aria-invalid': Boolean(error), 'aria-describedby': [field.description ? help : '', error ? alert : ''].filter(Boolean).join(' ') || undefined, disabled }
  const control = field.kind === 'boolean'
    ? field.required ? <input {...common} type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} /> : <select {...common} className="ui-input" value={String(value)} onChange={event => onChange(event.target.value)}><option value="">使用默认值</option><option value="true">是</option><option value="false">否</option></select>
    : field.kind === 'enum'
      ? <select {...common} className="ui-input" value={String(value)} onChange={event => onChange(event.target.value)}>{!field.required ? <option value="">使用默认值</option> : null}{field.choices?.map((choice, index) => <option key={index} value={JSON.stringify(choice)}>{pluginValueText(choice)}</option>)}</select>
      : field.kind === 'json'
        ? <textarea {...common} className="ui-input work-plugin-app__json" spellCheck={false} rows={4} value={String(value)} onChange={event => onChange(event.target.value)} placeholder={field.schema.type === 'array' ? '[]' : '{}'} />
        : <input {...common} className="ui-input" type={field.kind === 'string' ? 'text' : 'number'} step={field.kind === 'integer' ? 1 : 'any'} value={String(value)} onChange={event => onChange(event.target.value)} />
  return <div className={`work-plugin-app__field${field.kind === 'boolean' ? ' work-plugin-app__field--boolean' : ''}`}>
    <label htmlFor={id}>{field.label}{field.required ? <span className="work-plugin-app__required">必填</span> : null}</label>{control}
    {field.description ? <p id={help}>{field.description}</p> : null}{error ? <p id={alert} className="work-plugin-app__field-error" role="alert">{error}</p> : null}
  </div>
}

/** A published tool application uses host-native controls, never author-supplied scripts. */
export function PluginRunner({ id, name, revision, onBack, onEdit, initialTool }: { id: string; name: string; revision: number; onBack: () => void; onEdit: () => void; initialTool?: string }): JSX.Element {
  const source = getEngineSource(), active = useRef(true), epoch = useRef(0), prefix = useId()
  const [application, setApplication] = useState<PluginApplication | null>(null), [loading, setLoading] = useState(true), [running, setRunning] = useState(false)
  const [error, setError] = useState(''), [blocked, setBlocked] = useState(''), [toolName, setToolName] = useState(''), [values, setValues] = useState<PluginFormValues>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({}), [rawMode, setRawMode] = useState(false), [rawArgs, setRawArgs] = useState('{}'), [output, setOutput] = useState<PluginInvocation | null>(null)
  const tool = application?.manifest.tools.find(item => item.name === toolName)
  const fields = useMemo(() => tool ? pluginFormFields(tool) : [], [tool])
  const current = (captured: number): boolean => active.current && epoch.current === captured && source === getEngineSource()
  const chooseTool = (app: PluginApplication, selected: string): void => {
    const spec = app.manifest.tools.find(item => item.name === selected)
    if (!spec) return
    const defaults = app.examples.find(example => example.tool === selected)?.args ?? {}
    setToolName(selected); setValues(pluginFormDefaults(pluginFormFields(spec), defaults)); setRawArgs(JSON.stringify(defaults, null, 2)); setRawMode(!Object.keys(spec.inputSchema.properties ?? {}).length || Object.keys(spec.inputSchema.properties ?? {}).length > 64)
    setFieldErrors({}); setError(''); setOutput(null)
  }
  useEffect(() => {
    active.current = true
    const captured = ++epoch.current
    setLoading(true); setError(''); setBlocked(''); setOutput(null); setRunning(false); setApplication(null)
    void getPluginApplication(id, revision).then(app => {
      if (!current(captured)) return
      setApplication(app); chooseTool(app, app.manifest.tools.find(tool => tool.name === initialTool)?.name ?? app.manifest.tools[0].name)
    }).catch(cause => { if (current(captured)) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (current(captured)) setLoading(false) })
    return () => { active.current = false; epoch.current++ }
  }, [id, revision, source, initialTool])
  useEffect(() => subscribeResourceCatalogueChanges(['plugin'], change => {
    if (change.id !== id) return
    epoch.current++; setLoading(false); setRunning(false); setOutput(null)
    setBlocked('插件配置已变化，请返回列表后重新打开。')
  }), [id])
  const changeValue = (key: string, value: string | boolean): void => {
    setValues(previous => ({ ...previous, [key]: value })); setFieldErrors(previous => ({ ...previous, [key]: '' })); setError(''); setOutput(null)
  }
  const submit = async (): Promise<void> => {
    if (!application || !tool || running || blocked || !application.execution.allowed) return
    let args: Record<string, unknown>
    if (rawMode) {
      try { const parsed: unknown = JSON.parse(rawArgs); if (!pluginObject(parsed)) throw new Error('参数必须是 JSON 对象'); args = parsed }
      catch (cause) { setError(cause instanceof SyntaxError ? '参数 JSON 无效，请检查格式。' : String(cause)); return }
    } else {
      const parsed = parsePluginForm(fields, values)
      setFieldErrors(parsed.errors)
      if (Object.keys(parsed.errors).length) { document.getElementById(`${prefix}-${encodeURIComponent(Object.keys(parsed.errors)[0])}`)?.focus(); return }
      args = parsed.args
    }
    const captured = ++epoch.current
    setRunning(true); setError(''); setOutput(null)
    try { const result = await invokePluginApplication(application, tool.name, args); if (current(captured)) setOutput(result) }
    catch (cause) { if (current(captured)) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current(captured)) setRunning(false) }
  }
  const primitives = fields.filter(field => field.kind !== 'json'), advanced = fields.filter(field => field.kind === 'json')
  return <section className="work-plugins work-plugin-app" aria-label="插件操作页" aria-busy={loading || running}>
    <header className="work-plugins__heading work-plugins__heading--detail"><div className="work-plugins__title"><button className="btn btn--icon btn--ghost" type="button" aria-label="返回插件列表" title="返回插件列表" onClick={onBack}><Icon name="chevron-left" size={19} /></button><div><h1>{application?.name ?? name}</h1><p>{application?.description ?? `发布版本 r${revision}`}</p></div></div><button type="button" className="btn btn--icon btn--ghost" aria-label="编辑插件" title="编辑插件" disabled={running} onClick={onEdit}><Icon name="file-edit-outline" size={17} /></button></header>
    {loading ? <p className="work-plugin-app__loading" role="status">正在打开插件…</p> : application ? <>
      <div className="work-plugin-app__canvas"><form noValidate onSubmit={event => { event.preventDefault(); void submit() }}>
        <div className="work-plugin-app__tool"><label htmlFor={`${prefix}-tool`}>功能</label><select id={`${prefix}-tool`} aria-label="插件功能" className="ui-input" value={toolName} disabled={running || Boolean(blocked)} onChange={event => chooseTool(application, event.target.value)}>{application.manifest.tools.map(item => <option key={item.name} value={item.name}>{pluginToolTitle(item)}</option>)}</select><span>r{application.revision}</span></div>
        <p className="work-plugin-app__description">{tool?.description}</p>
        {rawMode ? <div className="work-plugin-app__field"><label htmlFor={`${prefix}-args`}>参数 JSON</label><textarea id={`${prefix}-args`} aria-label="运行参数 JSON" className="ui-input work-plugin-app__json" spellCheck={false} rows={10} disabled={running} value={rawArgs} onChange={event => { setRawArgs(event.target.value); setError(''); setOutput(null) }} /></div> : <><div className="work-plugin-app__fields">{primitives.map(field => <Field key={field.key} field={field} value={values[field.key] ?? ''} prefix={prefix} disabled={running} error={fieldErrors[field.key]} onChange={value => changeValue(field.key, value)} />)}</div>{advanced.length ? <details className="work-plugin-app__advanced" open={advanced.some(field => field.required || fieldErrors[field.key]) || undefined}><summary>高级参数</summary>{advanced.map(field => <Field key={field.key} field={field} value={values[field.key] ?? ''} prefix={prefix} disabled={running} error={fieldErrors[field.key]} onChange={value => changeValue(field.key, value)} />)}</details> : null}</>}
        {error ? <p className="work-plugin-app__error" role="alert">{error}</p> : null}
        {blocked || !application.execution.allowed ? <p className="work-plugin-app__error" role="alert">{blocked || application.execution.reason || '当前不允许执行插件。'}</p> : null}
        <footer className="work-plugin-app__submit"><button className="btn btn--primary" type="submit" disabled={running || Boolean(blocked) || !application.execution.allowed}><Icon name={running ? 'rotate-clockwise' : 'play'} size={15} />{running ? '正在运行…' : '运行'}</button>{!running ? <span>Return ↵</span> : <span role="status">正在调用插件…</span>}{fields.length ? <button type="button" className="btn btn--ghost work-plugin-app__json-toggle" disabled={running} onClick={() => { if (!rawMode) setRawArgs(JSON.stringify(parsePluginForm(fields, values).args, null, 2)); else { try { const parsed: unknown = JSON.parse(rawArgs); if (!pluginObject(parsed)) throw new Error(); setValues(pluginFormDefaults(fields, parsed)) } catch { setError('请先修正 JSON 参数，再切换表单。'); return } } setRawMode(value => !value); setFieldErrors({}); setError(''); setOutput(null) }}>{rawMode ? '表单输入' : 'JSON 参数'}</button> : null}</footer>
      </form>{output ? <InvocationResult output={output} /> : <div className="work-plugin-app__placeholder"><Icon name="play" size={22} /><p>填写参数，运行后在这里查看结果。</p></div>}</div>
    </> : <p className="work-plugin-app__error" role="alert">{blocked || error || '插件暂时无法打开。'}</p>}
  </section>
}
