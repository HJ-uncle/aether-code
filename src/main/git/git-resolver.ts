import { localToolchainEnvironment } from '../local-toolchains'
import { findWindowsGit } from './windows-git'

let cached: string | undefined
let childPaths: Record<string, string> | undefined

/** Also give hooks and transport helpers the same PATH as their parent Git process. */
export function gitProcessEnvironment(): NodeJS.ProcessEnv {
  childPaths ??= localToolchainEnvironment('git')
  return { ...process.env, ...childPaths, GIT_TERMINAL_PROMPT: '0' }
}

/** The panel, clone and search use the same Git as local commands, but never search the selected repository for an executable. */
export function resolveGitExecutable(): string {
  if (process.platform !== 'win32') return 'git'
  if (cached) return cached
  const env = gitProcessEnvironment()
  const file = findWindowsGit(env[Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'] ?? '')
  if (!file) throw new Error('未找到 Git。请将 Git 加入 PATH，或使用自带 Git 的 Windows x64 完整安装包。')
  cached = file
  return file
}
