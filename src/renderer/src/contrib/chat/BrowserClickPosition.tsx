import type { JSX } from 'react'
import type { ToolBrowserSnapshot } from './browser-snapshot'
import { BrowserPositionPreview } from './BrowserPositionPreview'

type Click = NonNullable<ToolBrowserSnapshot['interaction']>
const coordinate = (value: number): string => String(Math.round(value * 10) / 10)
const label = (value: string): string => value.length > 200 ? `${value.slice(0, 200)}…` : value

/** Coordinates belong to the viewport captured before dispatch, even if the click navigated away. */
export function BrowserClickPosition({ click }: { click: Click }): JSX.Element {
  const { width, height } = click.viewport
  const unit = Math.max(width, height) / 100
  const bounds = click.target?.bounds
  const locator = click.target?.selector || click.target?.ref
  return (
    <div className="tool-browser-click">
      <div className="tool-browser-click__heading">
        <strong>点击位置</strong>
        <span className="tool-browser-click__coords">X {coordinate(click.x)} · Y {coordinate(click.y)}</span>
      </div>
      {click.target ? (
        <div className="tool-browser-click__target">
          {click.target.name ? <span>{label(click.target.name)}</span> : null}
          {locator ? <span className="tool-browser-click__locator">{label(locator)}</span> : null}
        </div>
      ) : null}
      <BrowserPositionPreview screenshot={click.screenshot} viewport={click.viewport} title="点击前页面截图" className="tool-browser-click__map"
        description={`点击位置示意图，距视口左上角 X ${coordinate(click.x)}、Y ${coordinate(click.y)} 像素`}>
        <path className="tool-browser-click__guides" d={`M 0 ${click.y} H ${width} M ${click.x} 0 V ${height}`} />
        {bounds ? <rect className="tool-browser-click__bounds" x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} /> : null}
        <circle className="tool-browser-click__halo" cx={click.x} cy={click.y} r={unit * 3} />
        <circle className="tool-browser-click__point" cx={click.x} cy={click.y} r={unit * 1.2} />
      </BrowserPositionPreview>
      <div className="tool-browser-click__caption">{click.screenshot ? '点击前画面' : '点击时视口'} · {width} × {height} · 左上角为原点</div>
    </div>
  )
}
