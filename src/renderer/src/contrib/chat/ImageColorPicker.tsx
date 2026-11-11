import { useRef, useState, type JSX } from 'react'
import { ColorPicker } from '@renderer/workbench/ColorPicker'
import { Popover } from '@renderer/workbench/Popover'

export function ImageColorPicker({ value, onChange, disabled = false }: {
  value: string
  onChange: (color: string) => void
  disabled?: boolean
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const open = draft !== null && !disabled
  if (disabled && draft !== null) setDraft(null)
  const close = (): void => setDraft(null)
  const confirm = (color: string): void => {
    onChange(color)
    close()
    trigger.current?.focus({ preventScroll: true })
  }

  return <Popover className="image-color-picker" label="选择标注颜色" placement="up" width={320} flush
    open={open} disabled={disabled} onOpenChange={next => setDraft(next ? value : null)}
    trigger={() => <button ref={trigger} type="button" className="image-editor__tool image-color-picker__trigger"
      aria-label="标注颜色" aria-haspopup="dialog" aria-expanded={open} title={`标注颜色：${draft ?? value}`} disabled={disabled}>
      <span className="image-color-picker__sample" style={{ background: draft ?? value }} aria-hidden="true" />
    </button>}>
    {/* Unmount the draft immediately on dismissal so delayed previews and screen sampling cannot reopen it. */}
    {open ? <ColorPicker value={value} title="标注颜色"
      onPreview={color => setDraft(current => current === null ? null : color)} onConfirm={confirm} onCancel={close} /> : null}
  </Popover>
}
