/**
 * IPC 错误信息提取
 *
 * Electron 会把主进程抛出的错误包成
 * `Error invoking remote method 'xxx': Error: 真正的原因`，
 * 直接显示给用户既冗长又会盖住关键信息。这里剥掉前缀只留原因。
 *
 * 之所以独立成模块而不是留在 fs-client 里：fs 与 git 两套 IPC 都需要它，
 * 让它跟着某一个业务模块走会逼另一个模块去 import 不相干的文件。
 */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = 'Error: '
  const index = raw.lastIndexOf(marker)
  return index >= 0 ? raw.slice(index + marker.length) : raw
}
