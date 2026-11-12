import type { RootRunActivity, RootRunStatus } from '@shared/root-run'

/** Groups may share dependencies: show one named group, never sum their counts. */
export function sessionDependencyProgress(run: { status: RootRunStatus; activity?: RootRunActivity } | undefined):
  { groupId: string; label: string; detail: string; accessibleLabel: string } | undefined {
  if (run?.status !== 'running' || run.activity?.phase !== 'waiting_children') return undefined
  const groups = run.activity.groups
  const group = groups.find(item => item.state === 'blocked') ?? groups.find(item => item.state === 'waiting')
    ?? groups.find(item => item.state === 'ready')
  if (!group) return undefined
  const phase = group.state === 'blocked' ? '依赖受阻' : group.state === 'ready' ? '依赖已就绪' : '等待依赖'
  const label = `${phase} · ${group.settled}/${group.total}`
  const suffix = group.state === 'blocked' ? '正在处理未完成项。' : group.state === 'ready' ? '即将继续。' : '收齐后自动继续。'
  const detail = `${group.label}：已收取 ${group.settled}/${group.total} 项依赖${group.failed ? `，${group.failed} 项未成功` : ''}。${suffix}`
  return { groupId: group.id, label, detail, accessibleLabel: `${group.label}，${label}${group.failed ? `，${group.failed} 项未成功` : ''}` }
}
