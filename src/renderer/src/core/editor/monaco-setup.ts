/**
 * Monaco 环境初始化
 *
 * 关键点：worker 必须本地打包，不能用 @monaco-editor/react 的 CDN 模式 ——
 * 桌面 IDE 需要离线可用。这里用 Vite 的 ?worker 导入，产物是同源独立 chunk，
 * 无需额外插件。
 *
 * CSP 注意：worker 由 Vite 以同源文件形式加载，index.html 里已放行 worker-src。
 */
import * as monaco from 'monaco-editor'
import { fileIdentity } from './file-identity'
// monaco 0.56 起 exports 为 `"./*": "./esm/vs/*.js"`，因此子路径要相对 esm/vs/ 写，
// 不能再写成 monaco-editor/esm/vs/... （那会被 exports 映射成 .../esm/vs/esm/vs/...）
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

let initialized = false

/** 安装 worker 工厂。幂等，可重复调用。 */
export function setupMonacoEnvironment(): void {
  if (initialized) return
  initialized = true

  // 补回 Monaco 0.56 移除的 diff 语言（必须在任何 diff model 创建前注册）
  registerDiffLanguage()

  // monaco 通过全局 MonacoEnvironment 获取 worker 实例
  ;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new jsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker()
        case 'typescript':
        case 'javascript':
          return new tsWorker()
        default:
          return new editorWorker()
      }
    }
  }
}

/**
 * 按文件路径推断 Monaco 语言 ID。
 *
 * 直接查 Monaco 自己的语言注册表（覆盖 150+ 语言），比维护扩展名映射表可靠：
 * 语言支持随 Monaco 升级自动跟随，不需要我们同步维护。
 */
export function languageForPath(filePath: string): string {
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dotIndex = fileName.lastIndexOf('.')
  const ext = dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : ''

  // 先按完整文件名匹配（Dockerfile、Makefile 这类没有扩展名）
  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((name) => name.toLowerCase() === fileName.toLowerCase())) {
      return language.id
    }
  }

  if (ext) {
    for (const language of monaco.languages.getLanguages()) {
      if (language.extensions?.some((candidate) => candidate.toLowerCase() === ext)) {
        return language.id
      }
    }
  }

  return 'plaintext'
}

/** 主题定义与切换见 editor-theme.ts（从设计令牌取色，随外观/强调色联动） */

// ==================== Diff 语言（Monaco 0.56 已移除，补回） ====================
//
// VS Code 通过 extensions/diff 提供 diff 语法（TextMate），Monaco 用 Monarch。
// 这里手写一份，token 名照搬 VS Code TextMate scope，editor-theme.ts 里按
// VS Code Dark+/Light+ 默认配色着色——patch 文件不再满屏红。
let diffRegistered = false
function registerDiffLanguage(): void {
  if (diffRegistered) return
  diffRegistered = true

  monaco.languages.register({
    id: 'diff',
    extensions: ['.diff', '.patch', '.rej'],
    aliases: ['Diff', 'diff'],
    mimetypes: ['text/x-diff', 'text/x-patch']
  })

  monaco.languages.setMonarchTokensProvider('diff', {
    defaultToken: '',
    tokenPostfix: '',
    tokenizer: {
      root: [
        [/^diff\s.*$/, 'meta.diff.header'],
        [/^index\s.*$/, 'meta.diff.header'],
        [/^Index:\s.*$/, 'meta.diff.header'],
        [/^---\s.*$/, 'meta.diff.header'],
        [/^\+\+\+\s.*$/, 'meta.diff.header'],
        [/^@@.*@@.*$/, 'meta.diff.range'],
        [/^\+.*$/, 'markup.inserted.diff'],
        [/^-.*$/, 'markup.deleted.diff'],
        [/^!.*$/, 'markup.changed.diff'],
        [/^={3,}$/, 'meta.separator'],
        [/^-{3,}$/, 'meta.separator']
      ]
    }
  })

  monaco.languages.setLanguageConfiguration('diff', {
    brackets: [
      ['[', ']'],
      ['{', '}']
    ]
  })
}

// ==================== 模型缓存 ====================

/**
 * 每个文件一个 Monaco model。
 *
 * 不共用一个 model 反复 setValue：那样切换标签会丢失各自的撤销历史与
 * 光标位置。用 URI 区分还能让 TS/JSON 等 worker 正确按文件路径工作。
 */
const models = new Map<string, monaco.editor.ITextModel>()

/** 取（或创建）某个文件对应的 model */
export function acquireModel(filePath: string, language: string): monaco.editor.ITextModel {
  const key = fileIdentity(filePath)
  const existing = peekModel(filePath)
  if (existing) {
    models.set(key, existing)
    if (existing.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(existing, language)
    }
    return existing
  }

  const model = monaco.editor.createModel('', language, monaco.Uri.file(filePath))
  models.set(key, model)
  return model
}

/** 关闭标签时释放 model，避免长会话下内存持续增长 */
export function releaseModel(filePath: string): void {
  const model = peekModel(filePath)
  if (model && !model.isDisposed()) model.dispose()
  models.delete(fileIdentity(filePath))
}

/**
 * 只查不建：文件已打开时返回其 model，否则返回 null。
 * 清 markers 等收尾操作用它，避免 acquireModel 把已关闭的文件重新建出来。
 */
export function peekModel(filePath: string): monaco.editor.ITextModel | null {
  const key = fileIdentity(filePath)
  const model = models.get(key)
  if (model && !model.isDisposed()) return model
  // A language feature may already have loaded a URI before a document mounts.
  return monaco.editor.getModels().find((candidate) =>
    candidate.uri.scheme === 'file' && fileIdentity(candidate.uri.fsPath) === key) ?? null
}

export { monaco }
