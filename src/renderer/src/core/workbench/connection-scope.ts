export interface WorkbenchOwner {
  source: number
  sessionId: string | null
  mode: 'work' | 'code'
  enabled: boolean
}

/** Foreground mode is presentation state; the mounted session still owns its bridge. */
export function isWorkbenchOwnerCurrent(owner: WorkbenchOwner, latest: WorkbenchOwner, source: number, disposed: boolean): boolean {
  return !disposed && latest.enabled && owner.source === source && owner.source === latest.source &&
    owner.sessionId === latest.sessionId && owner.mode === latest.mode
}

export function deferredWorkPreview(path: string): Record<string, unknown> {
  return { path, opened: true, foreground: false, readStatus: 'not-confirmed', renderStatus: 'deferred-until-visible', visualVerification: false,
    message: '已在所属任务保留预览入口；该任务在后台，切回后才读取并显示文件，尚未确认内容或版式。' }
}
