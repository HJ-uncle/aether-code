import { useEffect, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useModels } from '@renderer/core/engine/model-store'
import { Icon } from '@renderer/workbench/icons'

/**
 * 思考模式选择器
 *
 * 放在输入框下方、与模型选择器并列：思考与否是「这一问」的临时决策，
 * 用户在这里能随手改，而不必跳到模型设置页改一条持久配置。
 *
 * 取值三态（存 settings.thinkingMode，跨会话沿用）：
 *   default — 不向引擎下发该字段，由引擎按模型能力判断
 *   on/off  — 显式下发 thinkingMode=true/false
 * 之所以要区分「默认」与「关」：引擎把不传视为「问能力」，把 false 视为
 * 强制关闭，两者在支持推理的模型上结果不同。
 */
export function ThinkingModePicker({
  value,
  onChange
}: {
  value: 'default' | 'on' | 'off'
  onChange: (next: 'default' | 'on' | 'off') => void
}): JSX.Element {
  const { ready } = useApp()
  const { models } = useModels()
  const { settings } = useApp()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = models.find((m) => m.modelId === settings.lastModelId)
  const supportsThinking = current?.capabilities?.thinking === true

  const OPTIONS: Array<{ value: 'default' | 'on' | 'off'; label: string; summary: string }> = [
    { value: 'default', label: '默认', summary: '不指定，由引擎按模型能力决定' },
    { value: 'on', label: '开启', summary: '强制开启推理输出（模型不支持时引擎会记录告警）' },
    { value: 'off', label: '关闭', summary: '强制关闭，跳过推理过程以降低延迟' }
  ]
  const descriptor = OPTIONS.find((item) => item.value === value) ?? OPTIONS[0]

  return (
    <div className="think-picker" ref={rootRef}>
      <button
        type="button"
        className={`think-picker__trigger${open ? ' is-open' : ''}${
          value === 'on' ? ' think-picker__trigger--on' : ''
        }`}
        disabled={!ready}
        title={
          supportsThinking
            ? `思考模式：${descriptor.label}；当前模型声明支持推理`
            : `思考模式：${descriptor.label}；当前模型未声明支持推理`
        }
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="brain" size={12} />
        <span className="picker__label">{descriptor.label}</span>
        <span className="think-picker__caret">⌃</span>
      </button>

      {open ? (
        <div className="think-picker__popup" role="menu">
          <div className="think-picker__section">思考模式</div>
          {OPTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="menuitem"
              className={`think-picker__item${item.value === value ? ' is-active' : ''}`}
              onClick={() => {
                onChange(item.value)
                setOpen(false)
              }}
            >
              <span className="think-picker__item-head">
                {item.label}
                {item.value === value ? <span className="think-picker__mark">当前</span> : null}
              </span>
              <small>{item.summary}</small>
            </button>
          ))}
          <div className="think-picker__hint">
            {current
              ? supportsThinking
                ? '当前模型已声明支持推理输出。'
                : '当前模型未声明支持推理；在「模型设置」里可为其开启。'
              : '未选择模型，将使用引擎默认模型。'}
          </div>
        </div>
      ) : null}
    </div>
  )
}
