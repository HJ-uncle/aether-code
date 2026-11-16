import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { normalizeRunPending, buildToolResponse } from '@renderer/core/engine/pending'
import type { PluginCapabilityStreamEvent } from '@renderer/core/engine/plugins'
import { PermissionCard } from '../interactions/PermissionCard'
import { QuestionCard } from '../interactions/QuestionCard'

export type PluginRunPending = Extract<PluginCapabilityStreamEvent, { type: 'pending' }>
export interface PluginRunDecision { event: PluginRunPending; ready: boolean; respond: (output: string) => Promise<void>; cancel: () => void }

/** This card is a trusted host sibling of the sandbox, never content authored by a plugin. */
export function PluginRunInteraction({ decision, pluginName }: { decision: PluginRunDecision; pluginName: string }): JSX.Element | null {
  const pending = useMemo(() => normalizeRunPending(decision.event.pending, decision.event.runId), [decision.event])
  const [values, setValues] = useState<string[][]>(() => pending?.groups.map(() => []) ?? [])
  const [freeText, setFreeText] = useState<string[]>(() => pending?.groups.map(() => '') ?? [])
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState(''), busy = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => { if (decision.ready) form.current?.focus({ preventScroll: true }) }, [decision.ready])
  if (!pending) return null
  const answers = pending.groups.map((_, index) => [...(values[index] ?? []), freeText[index]?.trim()].filter(Boolean).join('、'))
  const reply = async (selected: string[]): Promise<void> => {
    if (busy.current || !decision.ready) return
    busy.current = true; setSubmitting(true); setError('')
    try { await decision.respond(buildToolResponse(pending, selected).output) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { busy.current = false; setSubmitting(false) }
  }
  const blocked = submitting || !decision.ready
  return <section className="extension-page__interaction" aria-label={`${pluginName} 请求确认`}>
    <header><span>{pluginName}</span><button type="button" className="btn btn--ghost" onClick={decision.cancel}>停止任务</button></header>
    <form ref={form} tabIndex={-1} className={`work-pending work-pending--${pending.kind === 'permission' ? 'permission' : 'question'}`} aria-label={pending.kind === 'permission' ? '插件操作确认' : '插件补充信息'} aria-busy={submitting} onSubmit={event => { event.preventDefault(); if (pending.kind === 'ask' && answers.every(Boolean)) void reply(answers) }}>
      {pending.sourceChange?.wait ? <p className="extension-page__notice">其他任务可能仍在修改文件。请在适当时重新检查，或停止当前任务。</p> : null}
      {pending.kind === 'permission' ? <PermissionCard pending={pending} blocked={blocked} submitting={submitting ? 'reply' : null} allowFullAccess={false} allowAutomaticWait={false} onReply={selected => { void reply(selected) }} /> : <QuestionCard pending={pending} values={values} freeText={freeText} blocked={blocked} submitting={submitting}
        onSelect={(index, value, checked) => setValues(previous => previous.map((list, groupIndex) => groupIndex !== index ? list : pending.groups[index].multiSelect ? checked ? [...list, value] : list.filter(item => item !== value) : [value]))}
        onText={(index, text) => setFreeText(previous => previous.map((value, groupIndex) => groupIndex === index ? text : value))} />}
      {error ? <p className="work-pending__error" role="alert">{error}</p> : null}
    </form>
  </section>
}
