import { watchFile, unwatchFile, type Stats } from 'node:fs'
import { assertAllowed } from './file-service'

/** 只观察打开的文件，避免对整个依赖目录递归监听；原子替换、删除后重建也能继续跟踪。 */
export function watchDocuments(paths: string[], onChanged: (paths: string[]) => void): () => void {
  const safePaths = [...new Set(paths.map(assertAllowed))]
  const changed = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const registrations = safePaths.map((path) => {
    const listener = (current: Stats, previous: Stats): void => {
      if (current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs &&
          current.size === previous.size && current.ino === previous.ino && current.nlink === previous.nlink) return
      changed.add(path)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        onChanged([...changed])
        changed.clear()
      }, 80)
    }
    watchFile(path, { interval: 700, persistent: false }, listener)
    return () => unwatchFile(path, listener)
  })
  return () => {
    if (timer) clearTimeout(timer)
    registrations.forEach((dispose) => dispose())
  }
}
