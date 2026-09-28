/**
 * 文件系统客户端（渲染层）
 *
 * 薄封装 window.aether.fs。所有调用都可能抛错（路径越界、不存在、无权限），
 * 调用方需要处理 —— 这里不做统一吞异常，否则用户看不到失败原因。
 */
import type {
  CopyIntoWorkspaceInput,
  CopyIntoWorkspaceResult,
  FsEntry,
  FsFileContent,
  FsStat
} from '@shared/ipc'

function bridge(): Window['aether'] {
  const api = window.aether
  if (!api) throw new Error('IPC 桥未就绪：preload 未加载')
  return api
}

/** 把目录加入主进程的工作区白名单（从「最近打开」直接进入时，没有经过选择框授权） */
export function allowRoot(root: string): Promise<void> {
  return bridge().fs.allowRoot(root)
}

export function pickFolder(): Promise<string | null> {
  return bridge().fs.pickFolder()
}

export function readDir(dir: string): Promise<FsEntry[]> {
  return bridge().fs.readDir(dir)
}

export function readFile(path: string): Promise<FsFileContent> {
  return bridge().fs.readFile(path)
}

export function writeFile(path: string, content: string): Promise<FsStat> {
  return bridge().fs.writeFile(path, content)
}

export function createFile(path: string): Promise<void> {
  return bridge().fs.createFile(path)
}

export function createFolder(path: string): Promise<void> {
  return bridge().fs.createFolder(path)
}

export function rename(src: string, dest: string): Promise<void> {
  return bridge().fs.rename(src, dest)
}

export function copy(src: string, dest: string): Promise<void> {
  return bridge().fs.copy(src, dest)
}

export function trash(path: string): Promise<void> {
  return bridge().fs.trash(path)
}

export function stat(path: string): Promise<FsStat> {
  return bridge().fs.stat(path)
}

/**
 * 把本地文件的字节流落盘到工作区，返回落地路径与相对路径。
 *
 * 附件走这条路而不是直接给引擎绝对路径：引擎的工作区白名单只认
 * 工作区内的相对路径，且 File 对象本就拿不到真实磁盘位置。
 */
export function copyIntoWorkspace(input: CopyIntoWorkspaceInput): Promise<CopyIntoWorkspaceResult> {
  return bridge().fs.copyIntoWorkspace(input)
}

/** 路径工具：不依赖 node:path（渲染进程没有 Node 能力） */
export const paths = {
  /** 取最后一段（文件名或目录名） */
  basename(p: string): string {
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts[parts.length - 1] ?? p
  },
  /** 取父目录 */
  dirname(p: string): string {
    const normalized = p.replace(/\\/g, '/')
    const index = normalized.lastIndexOf('/')
    if (index <= 0) return normalized.slice(0, index + 1) || normalized
    return normalized.slice(0, index)
  },
  /** 以 / 拼接（保持跨平台可读性；主进程会再 resolve 一次） */
  join(...segments: string[]): string {
    return segments
      .map((segment, index) =>
        index === 0 ? segment.replace(/[/\\]+$/, '') : segment.replace(/^[/\\]+|[/\\]+$/g, '')
      )
      .filter(Boolean)
      .join('/')
  },
  /**
   * child 是否位于 parent 之内（含自身）。
   *
   * 两种分隔符都归一化后比较：主进程给的路径是 Windows 反斜杠，
   * 而这里拼接出来的可能是正斜杠，直接 startsWith 会漏判。
   */
  contains(parent: string, child: string): boolean {
    const from = parent.replace(/\\/g, '/').replace(/\/+$/, '')
    const to = child.replace(/\\/g, '/')
    return to === from || to.startsWith(`${from}/`)
  },
  /**
   * 取 child 相对 parent 的路径，供 glob 匹配使用（分隔符统一成正斜杠）。
   *
   * 不在 parent 之内时原样返回 child 并单独剥掉前导分隔符 ——
   * 匹配器拿到的至少是个可用字符串，不会因相对化失败而整条规则失效。
   */
  relative(parent: string, child: string): string {
    const from = parent.replace(/\\/g, '/').replace(/\/+$/, '')
    const to = child.replace(/\\/g, '/').replace(/\/+$/, '')
    if (to === from) return ''
    if (to.startsWith(`${from}/`)) return to.slice(from.length + 1)
    return to.replace(/^\/+/, '')
  }
}
