import { useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { Icon } from '@renderer/workbench/icons'
import './work-question-card.css'

interface Props {
  pending: PendingInteraction
  values: string[][]
  freeText: string[]
  blocked: boolean
  submitting: boolean
  onSelect: (index: number, value: string, checked: boolean) => void
  onText: (index: number, value: string) => void
}

/** The request keeps its answers in WorkPending so navigating questions never submits or loses a draft. */
export function WorkQuestionCard({
  pending,
  values,
  freeText,
  blocked,
  submitting,
  onSelect,
  onText
}: Props): JSX.Element {
  const [active, setActive] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const question = useRef<HTMLLegendElement>(null)
  const focusNext = useRef(false)
  useLayoutEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    question.current?.focus()
  }, [active])
  const id = useId()
  const group = pending.groups[active]
  const answered = pending.groups.map((_, index) =>
    Boolean(values[index]?.length || freeText[index]?.trim())
  )
  const count = answered.filter(Boolean).length
  const selectQuestion = (index: number): void => {
    if (index === active) return
    setActive(index)
    if (body.current) body.current.scrollTop = 0
  }
  return (
    <div className="work-question">
      <header className="work-permission__header">
        <Icon name="chat" size={18} />
        <h3>需要你的意见</h3>
      </header>
      {pending.groups.length > 1 ? (
        <div className="work-question__navigation" role="group" aria-label="问题导航">
          <div className="work-permission__segments">
            {pending.groups.map((item, index) => (
              <button
                type="button"
                key={index}
                aria-label={item.tab || `问题 ${index + 1}`}
                aria-pressed={active === index}
                aria-controls={`${id}-question`}
                className={active === index ? 'is-selected' : ''}
                onClick={() => selectQuestion(index)}
              >
                {item.tab || `问题 ${index + 1}`}
                {answered[index] ? <Icon name="check" size={12} /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="work-question__body" ref={body}>
        {group ? (
          <fieldset id={`${id}-question`} disabled={blocked}>
            <legend ref={question} tabIndex={-1}>
              {group.question}
            </legend>
            {group.options.length ? (
              <p className="work-question__hint">
                {group.multiSelect ? '可选择多项' : '请选择一项'}
                {group.allowInput ? '，也可以补充回答' : ''}
              </p>
            ) : null}
            <div className="work-question__options">
              {group.options.map((option) => (
                <label
                  className={`work-question__option${values[active]?.includes(option.value) ? ' is-selected' : ''}`}
                  key={option.value}
                >
                  <input
                    type={group.multiSelect ? 'checkbox' : 'radio'}
                    name={`${pending.toolCallId}-${active}`}
                    checked={values[active]?.includes(option.value) ?? false}
                    onChange={(event) => onSelect(active, option.value, event.target.checked)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                </label>
              ))}
            </div>
            {group.allowInput ? (
              <label className="work-question__input">
                <span>{group.options.length ? '补充回答' : '你的回答'}</span>
                <textarea
                  className="ui-input"
                  rows={2}
                  aria-label={`补充回答：${group.question}`}
                  placeholder="输入你的想法…"
                  value={freeText[active] ?? ''}
                  onChange={(event) => onText(active, event.target.value)}
                />
              </label>
            ) : null}
          </fieldset>
        ) : null}
      </div>
      <footer className="work-permission__footer work-question__footer">
        <span className="work-question__progress">
          {pending.groups.length > 1
            ? `已回答 ${count} / ${pending.groups.length}`
            : group?.multiSelect && values[active]?.length
              ? `已选 ${values[active].length} 项`
              : ''}
        </span>
        <div className="work-permission__decisions">
          {active < pending.groups.length - 1 ? (
            <button
              className="btn"
              type="button"
              onClick={() => {
                focusNext.current = true
                selectQuestion(active + 1)
              }}
            >
              下一题
            </button>
          ) : null}
          <button
            className="btn btn--primary"
            type="submit"
            disabled={blocked || count !== pending.groups.length}
          >
            {submitting ? '正在提交…' : '提交回复'}
          </button>
        </div>
      </footer>
    </div>
  )
}
