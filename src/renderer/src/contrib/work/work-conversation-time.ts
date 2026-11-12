import { useEffect, useState } from 'react'
import type { WorkConversationGroup } from './work-conversation-turns'

function validTimestamp(value: number | undefined | null): value is number {
  return typeof value === 'number' && value > 0 && Number.isFinite(new Date(value).getTime())
}

export function workConversationStartedAt(group: Pick<WorkConversationGroup, 'messages'>): number | null {
  const admission = group.messages.find(message => message.role === 'user' && !message.rootFollowup)
  if (validTimestamp(admission?.createdAt)) return admission.createdAt
  // Partial archives may omit the admission. A supplement or final reply must
  // never move the timestamp of an otherwise known root.
  const roots = group.messages.map(message => message.run?.createdAt).filter(validTimestamp)
  if (roots.length) return Math.min(...roots)
  const messages = group.messages.filter(message => !message.rootFollowup).map(message => message.createdAt).filter(validTimestamp)
  return messages.length ? Math.min(...messages) : null
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
}

export function formatWorkConversationTime(timestamp: number | null, today: Date): { dateTime: string; label: string; title: string } | null {
  if (!validTimestamp(timestamp)) return null
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const fullDate = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const day = sameDay(date, today) ? '今天' : sameDay(date, yesterday) ? '昨天'
    : date.getFullYear() === today.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日` : fullDate
  return { dateTime: date.toISOString(), label: `${day} ${time}`, title: `${fullDate} ${time}:${pad(date.getSeconds())}` }
}

/** One calendar clock per conversation keeps relative dates correct after
 * midnight or sleep without adding a polling timer to every historical turn. */
export function useWorkConversationDate(active: boolean): Date {
  const [today, setToday] = useState(() => new Date())
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout>
    const refresh = (): void => {
      clearTimeout(timer)
      const now = new Date()
      setToday(previous => sameDay(previous, now) ? previous : now)
      const next = new Date(now)
      next.setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, next.getTime() - now.getTime())
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [active])
  return today
}
