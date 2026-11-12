import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'

const MOTION_DURATION = 320
const DIGITS = Array.from({ length: 30 }, (_, index) => String(index % 10))
type NumberMotion = 'up' | 'down' | 'idle'

/** Keep the preference live, including changes made while a tooltip is open. */
export function useReducedContextMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

function RollingDigit({ character, motion, reduced }: {
  character: string
  motion: NumberMotion
  reduced: boolean
}): JSX.Element {
  const reelRef = useRef<HTMLSpanElement>(null)
  const positionRef = useRef(10 + Number(character))
  const frameRef = useRef(0)

  useLayoutEffect(() => {
    window.cancelAnimationFrame(frameRef.current)
    const reel = reelRef.current
    if (!reel) return
    const digit = Number(character)
    const draw = (position: number): void => {
      positionRef.current = position
      reel.style.transform = 'translateY(' + (-position) + 'em)'
    }
    // Repeating rows let us normalize without changing the visible frame. An interrupted
    // update starts at the current fractional position, rather than the previous target.
    const start = ((positionRef.current % 10) + 10) % 10 + 10
    draw(start)
    if (reduced || motion === 'idle') {
      draw(10 + digit)
      return
    }
    const distance = motion === 'up'
      ? ((digit - start % 10) + 10) % 10
      : -(((start % 10 - digit) + 10) % 10)
    if (Math.abs(distance) < 0.001) {
      draw(10 + digit)
      return
    }
    const startedAt = performance.now()
    const tick = (now: number): void => {
      // rAF reports the frame start, which can precede this layout effect.
      const elapsed = Math.max(0, now - startedAt)
      const progress = Math.min(1, elapsed / MOTION_DURATION)
      const eased = 1 - Math.pow(1 - progress, 3)
      draw(start + distance * eased)
      if (progress < 1) frameRef.current = window.requestAnimationFrame(tick)
      else draw(10 + digit)
    }
    frameRef.current = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameRef.current)
  }, [character, motion, reduced])

  return (
    <span className="ctx-number__digit">
      <span ref={reelRef} className="ctx-number__reel" style={{ transform: 'translateY(' + (-(10 + Number(character))) + 'em)' }}>
        {DIGITS.map((digit, index) => <span key={index} className="ctx-number__glyph" data-character={digit} />)}
      </span>
    </span>
  )
}

/** Stable place-value keys preserve each reel across comma and digit-count changes. */
function numberCharacters(formatted: string): Array<{ key: string; character: string; digit: boolean }> {
  const decimalIndex = formatted.indexOf('.')
  const integerEnd = decimalIndex < 0 ? formatted.length : decimalIndex
  let place = [...formatted.slice(0, integerEnd)].filter((character) => /[0-9]/.test(character)).length - 1
  return [...formatted].map((character, index) => {
    const digit = /[0-9]/.test(character)
    const key = index < integerEnd
      ? digit ? 'place-' + place-- : 'separator-' + (place + 1)
      : index === decimalIndex ? 'decimal' : 'fraction-' + (index - decimalIndex)
    return { key, character, digit }
  })
}

export function RollingContextNumber({ value, formatted, reduced, testId }: {
  value: number
  formatted: string
  reduced: boolean
  testId: string
}): JSX.Element {
  const previousRef = useRef(value)
  const timerRef = useRef(0)
  const [motion, setMotion] = useState<NumberMotion>('idle')
  const direction: NumberMotion = reduced ? 'idle' : value > previousRef.current ? 'up' : value < previousRef.current ? 'down' : motion

  useLayoutEffect(() => {
    window.clearTimeout(timerRef.current)
    const nextMotion = reduced ? 'idle' : value > previousRef.current ? 'up' : value < previousRef.current ? 'down' : 'idle'
    previousRef.current = value
    setMotion(nextMotion)
    if (nextMotion !== 'idle') timerRef.current = window.setTimeout(() => setMotion('idle'), MOTION_DURATION + 16)
    return () => window.clearTimeout(timerRef.current)
  }, [value, reduced])

  return (
    <span className="ctx-number" data-testid={testId} data-value={value} data-motion={direction} data-reduced-motion={reduced} aria-label={formatted}>
      <span className="ctx-number__readable">{formatted}</span>
      <span className="ctx-number__visual" aria-hidden="true">
        {numberCharacters(formatted).map(({ key, character, digit }) => digit
          ? <RollingDigit key={key} character={character} motion={direction} reduced={reduced} />
          : <span key={key} className="ctx-number__separator" data-character={character} />)}
      </span>
    </span>
  )
}

export function ContextUsageBar({ ratio, reduced }: { ratio: number; reduced: boolean }): JSX.Element {
  const target = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const fillRef = useRef<HTMLDivElement>(null)
  const gainRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef(target)
  const frameRef = useRef(0)
  const [motion, setMotion] = useState<'grow' | 'shrink' | 'idle'>('idle')

  useLayoutEffect(() => {
    window.cancelAnimationFrame(frameRef.current)
    const fill = fillRef.current
    const gain = gainRef.current
    if (!fill || !gain) return
    const start = currentRef.current
    const growing = target > start
    const draw = (value: number): void => {
      currentRef.current = value
      fill.style.width = value * 100 + '%'
      gain.style.left = start * 100 + '%'
      gain.style.width = Math.max(0, value - start) * 100 + '%'
    }
    gain.dataset.active = 'false'
    gain.style.opacity = '0'
    if (reduced || Math.abs(target - start) < 0.0000001) {
      draw(target)
      setMotion('idle')
      return
    }
    draw(start)
    setMotion(growing ? 'grow' : 'shrink')
    gain.dataset.active = String(growing)
    const startedAt = performance.now()
    const tick = (now: number): void => {
      const elapsed = Math.max(0, now - startedAt)
      const progress = Math.min(1, elapsed / MOTION_DURATION)
      const eased = 1 - Math.pow(1 - progress, 3)
      draw(start + (target - start) * eased)
      gain.style.opacity = growing ? String(Math.max(0, 1 - Math.max(0, elapsed - MOTION_DURATION) / 240)) : '0'
      if (progress === 1) setMotion('idle')
      if (elapsed < MOTION_DURATION + (growing ? 240 : 0)) frameRef.current = window.requestAnimationFrame(tick)
      else {
        gain.dataset.active = 'false'
        gain.style.opacity = '0'
      }
    }
    frameRef.current = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameRef.current)
  }, [target, reduced])

  return (
    <div className="ctx-card__bar" data-testid="context-usage-bar" data-ratio={target} data-motion={reduced ? 'idle' : motion} data-reduced-motion={reduced}>
      <div ref={fillRef} className={'ctx-card__bar-fill' + (target >= 0.9 ? ' ctx-card__bar-fill--warn' : '')} style={{ width: target * 100 + '%' }} />
      <div ref={gainRef} className="ctx-card__bar-gain" data-active="false" />
    </div>
  )
}
