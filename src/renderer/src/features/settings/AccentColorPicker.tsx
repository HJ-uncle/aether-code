import type { JSX } from 'react'
import { ColorPicker, type ColorPickerProps } from '@renderer/ui/ColorPicker'

export function AccentColorPicker(props: Omit<ColorPickerProps, 'title' | 'hexLabel'>): JSX.Element {
  return <ColorPicker {...props} hexLabel="自定义强调色色值" />
}
