import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX
} from 'react'
import { createPortal } from 'react-dom'
import type { RootRunCompaction } from '@shared/root-run'
import { useAppMode } from '@renderer/core/platform/app-mode'
import {
  ContextUsageBar,
  RollingContextNumber,
  useReducedContextMotion
} from './ContextUsageMotion'
import { formatTokens } from './usage'

/** The ring observes engine-owned automatic compaction; it never starts maintenance. */
export function ContextUsageIndicator({
  owner = 'code',
  requestEstimate,
  used,
  limit,
  estimated,
  provisional,
  usageKnown,
  compaction,
  streaming
}: {
  owner?: 'code' | 'work'
  used: number
  limit: number
  estimated?: boolean
  provisional?: boolean
  requestEstimate?: number
  usageKnown: boolean
  compaction?: RootRunCompaction
  streaming: boolean
}): JSX.Element {
  const appMode = useAppMode()
  const [hoverAnchor, setHoverAnchor] = useState<{ rect: DOMRect; element: HTMLDivElement } | null>(
    null
  )
  const ringRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef(0)
  const scope = `${appMode}:${owner}`
  const [previousScope, setPreviousScope] = useState(scope)
  if (scope !== previousScope) {
    setPreviousScope(scope)
    setHoverAnchor(null)
  }
  const openHover = (element: HTMLDivElement): void => {
    if (appMode !== owner) return
    window.clearTimeout(closeTimerRef.current)
    setHoverAnchor({ rect: element.getBoundingClientRect(), element })
  }
  const scheduleCloseHover = (): void => {
    window.clearTimeout(closeTimerRef.current)
    if (document.activeElement === ringRef.current) return
    closeTimerRef.current = window.setTimeout(() => setHoverAnchor(null), 200)
  }
  useEffect(() => () => window.clearTimeout(closeTimerRef.current), [])
  // Both workspaces remain mounted; a body portal must close when its owner is hidden.
  useEffect(() => {
    if (appMode === owner) return
    window.clearTimeout(closeTimerRef.current)
  }, [appMode, owner])
  // Persisted completion time, rather than navigation time, owns this brief notice.
  const finishedAt = compaction?.finishedAt
  const compactionPhase = compaction?.phase
  const recentSnapshot = useCallback(
    () => finishedAt !== undefined && Date.now() < finishedAt + 6000,
    [finishedAt]
  )
  const subscribeRecent = useCallback(
    (notify: () => void) => {
      if (compactionPhase === 'running' || finishedAt === undefined) return () => {}
      const timer = window.setTimeout(notify, Math.max(0, finishedAt + 6001 - Date.now()))
      return () => window.clearTimeout(timer)
    },
    [compactionPhase, finishedAt]
  )
  const recent = useSyncExternalStore(subscribeRecent, recentSnapshot)
  const phase = compaction?.phase === 'running' ? 'running' : recent ? compaction?.phase : undefined
  const busy = phase === 'running'
  const ratio = Math.min(1, used / limit)
  const percent = Math.round(ratio * 100)
  const precisePercent = (Math.round((Math.min(used, limit) * 100_000) / limit) / 1000).toFixed(3)
  const radius = 10
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - ratio)
  const warn = ratio >= 0.85
  const status = busy
    ? '正在自动压缩上下文'
    : phase === 'succeeded'
      ? '自动压缩完成' +
        (compaction?.beforeTokens !== undefined && compaction.afterTokens !== undefined
          ? '（历史估算 ' +
            formatTokens(compaction.beforeTokens) +
            ' → ' +
            formatTokens(compaction.afterTokens) +
            '）'
          : '')
      : phase === 'failed'
        ? '自动压缩失败' + (compaction?.error ? '：' + compaction.error : '')
        : undefined
  const title =
    status ??
    (usageKnown
      ? '上下文用量 ' +
        precisePercent +
        '%（最近一次模型请求 ' +
        formatTokens(used) +
        ' / ' +
        formatTokens(limit) +
        '；' +
        used.toLocaleString('en-US') +
        ' / ' +
        limit.toLocaleString('en-US') +
        ' tokens）'
      : '上下文用量尚未确认')
  return (
    <>
      <div
        ref={ringRef}
        role="img"
        tabIndex={0}
        className={
          'context-ring' + (warn ? ' context-ring--warn' : '') + (busy ? ' context-ring--busy' : '')
        }
        aria-label={title}
        aria-busy={busy}
        data-compaction-phase={phase ?? 'idle'}
        data-context-source={
          provisional === true
            ? 'provisional'
            : estimated === true
              ? 'estimated'
              : estimated === false
                ? 'reported'
                : 'unknown'
        }
        data-context-pending={
          requestEstimate !== undefined || estimated === true || provisional === true
            ? 'true'
            : 'false'
        }
        onMouseEnter={(event) => openHover(event.currentTarget)}
        onMouseLeave={scheduleCloseHover}
        onFocus={(event) => openHover(event.currentTarget)}
        onBlur={scheduleCloseHover}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setHoverAnchor(null)
        }}
      >
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
          <circle
            className="context-ring__track"
            cx="13"
            cy="13"
            r={radius}
            fill="none"
            strokeWidth="2.5"
          />
          <circle
            className="context-ring__bar"
            cx="13"
            cy="13"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={busy ? circumference * 0.25 : offset}
          />
        </svg>
        <span className="context-ring__label" aria-hidden="true">
          {busy
            ? '…'
            : phase === 'succeeded'
              ? '✓'
              : phase === 'failed'
                ? '✕'
                : usageKnown
                  ? percent
                  : '—'}
        </span>
      </div>
      {hoverAnchor && appMode === owner ? (
        <ContextRingCard
          requestEstimate={requestEstimate}
          anchor={hoverAnchor.rect}
          anchorElement={hoverAnchor.element}
          used={used}
          limit={limit}
          estimated={estimated}
          provisional={provisional}
          usageKnown={usageKnown}
          compactionPhase={phase}
          status={status}
          streaming={streaming}
        />
      ) : null}
    </>
  )
}

/**
 * 上下文用量环的 hover 卡片（布局对齐 wuzu ContextUsageRing 的 tooltip）。
 * 结构：标题行（上下文窗口）→ 大号百分比 + 右侧「已用 / 上限」→ 底部状态提示；
 * 自动压缩状态来自引擎；已确认的模型输入快照独立保留。
 * 信息卡不包含操作，鼠标可以穿过卡片继续点击输入框；定位在环的上方并贴边钳制。
 */
function ContextRingCard({
  requestEstimate,
  anchor,
  anchorElement,
  used,
  limit,
  estimated,
  provisional,
  usageKnown,
  compactionPhase,
  status,
  streaming
}: {
  requestEstimate?: number
  anchor: DOMRect
  anchorElement: HTMLDivElement | null
  used: number
  limit: number
  estimated?: boolean
  provisional?: boolean
  usageKnown: boolean
  compactionPhase?: RootRunCompaction['phase']
  status?: string
  streaming: boolean
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const percent = ((Math.min(used, limit) * 100) / limit).toFixed(1)

  const reducedMotion = useReducedContextMotion()
  const positionCard = useCallback((): void => {
    const el = cardRef.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    const currentAnchor = anchorElement?.getBoundingClientRect() ?? anchor
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin)
    const x = Math.min(
      Math.max(margin, currentAnchor.left + (currentAnchor.width - rect.width) / 2),
      maxX
    )
    let y = currentAnchor.top - rect.height - margin
    if (y < margin) y = currentAnchor.bottom + margin
    y = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - rect.height - margin))
    el.style.left = x + 'px'
    el.style.top = y + 'px'
    el.style.visibility = 'visible'
    el.dataset.positioned = 'true'
  }, [anchor, anchorElement])

  // Position before every paint; changing source/status text must not leave one frame
  // at an old location. The observer also covers font and viewport size changes.
  useLayoutEffect(positionCard)
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    const observer = new ResizeObserver(positionCard)
    const targets = [
      el,
      anchorElement,
      anchorElement?.closest('.chat__toolbar'),
      anchorElement?.closest('.chat__surface')
    ]
    for (const target of targets) if (target) observer.observe(target)
    window.addEventListener('resize', positionCard)
    window.addEventListener('scroll', positionCard, true)
    // ResizeObserver cannot see an equal-sized toolbar move after its sibling changes.
    // Track only the anchor bounds while open, and reposition only when they change.
    let frame = 0
    let previousBounds = ''
    const trackAnchor = (): void => {
      const rect = anchorElement?.getBoundingClientRect() ?? anchor
      const bounds = [rect.left, rect.top, rect.width, rect.height].join(',')
      if (bounds !== previousBounds) {
        previousBounds = bounds
        positionCard()
      }
      frame = window.requestAnimationFrame(trackAnchor)
    }
    frame = window.requestAnimationFrame(trackAnchor)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', positionCard)
      window.removeEventListener('scroll', positionCard, true)
    }
  }, [anchor, anchorElement, positionCard])

  return createPortal(
    <div
      ref={cardRef}
      className="git-stashcard ctx-card"
      role="tooltip"
      data-testid="context-usage-card"
      data-reduced-motion={reducedMotion}
      style={{ pointerEvents: 'none', visibility: 'hidden' }}
    >
      <div className="ctx-card__header">
        <span>当前上下文</span>
        <span className="ctx-card__percent">
          {compactionPhase === 'running' ? (
            '压缩中…'
          ) : usageKnown ? (
            <>
              <RollingContextNumber
                value={Number(percent)}
                formatted={percent}
                reduced={reducedMotion}
                testId="context-percent-number"
              />
              <span className="ctx-card__percent-sign">%</span>
            </>
          ) : (
            '—'
          )}
        </span>
      </div>
      <div className="ctx-card__tokens">
        <span className="ctx-card__tokens-value">
          {usageKnown ? (
            <RollingContextNumber
              value={used}
              formatted={formatTokens(used)}
              reduced={reducedMotion}
              testId="context-used-compact-number"
            />
          ) : (
            '尚未确认'
          )}{' '}
          / {formatTokens(limit)}
        </span>
        <span className="ctx-card__tokens-label">使用 / 上限</span>
      </div>
      <div className="ctx-card__exact-tokens">
        {usageKnown ? (
          <RollingContextNumber
            value={used}
            formatted={used.toLocaleString('en-US')}
            reduced={reducedMotion}
            testId="context-used-number"
          />
        ) : (
          '尚未确认'
        )}{' '}
        / {limit.toLocaleString('en-US')} tokens
      </div>
      {compactionPhase === 'running' ? (
        <div
          className="ctx-card__bar ctx-card__bar--compacting"
          role="progressbar"
          aria-label="自动压缩上下文"
          aria-valuetext="正在自动压缩"
          data-reduced-motion={reducedMotion}
        />
      ) : (
        <ContextUsageBar ratio={used / limit} reduced={reducedMotion} />
      )}
      <div className="ctx-card__hint ctx-card__source-hint">
        {provisional === true
          ? '当前模型请求'
          : estimated === false
            ? '最近确认的模型请求'
            : streaming
              ? '当前请求'
              : '最近一次模型请求'}
        的输入
        {provisional === true
          ? '（模型初步统计）；等待最终确认。'
          : estimated === true
            ? '估算（本地预估）；等待模型确认。'
            : estimated === false
              ? requestEstimate !== undefined
                ? '（模型统计）；最新请求输入尚未确认。'
                : '（模型统计）。'
              : '（模型统计或估算）。'}
      </div>
      <div className="ctx-card__hint ctx-card__status-hint" role="status">
        {status ? (
          <span className={compactionPhase === 'failed' ? 'ctx-card__error' : undefined}>
            {status}
          </span>
        ) : streaming ? (
          '生成中；引擎会在需要时自动压缩上下文。'
        ) : (
          '引擎会在需要时自动压缩上下文。'
        )}
      </div>
      <div className="ctx-card__hint ctx-card__billing-hint">
        此处是单次请求占用，不等于累计计费用量。
      </div>
    </div>,
    document.body
  )
}
