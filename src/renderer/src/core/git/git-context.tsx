import { createContext, useContext, type JSX, type ReactNode } from 'react'
import { codeGitStore } from './git-store'
import type { GitStore } from './git-store-instance'
import type { GitCommitFileChange } from '@shared/git-types'

export interface GitPanelHost {
  cwd?: string | null
  unavailableReason?: string
  onOpenFile?: (path: string) => void | Promise<void>
  onOpenDiff?: (path: string, staged: boolean) => void | Promise<void>
  onOpenCommitDiff?: (file: GitCommitFileChange, hash: string) => void | Promise<void>
  onClone?: () => void
  /** Task panels own their lifecycle and must never replace Code's workspace. */
  task?: boolean
}

const GitContext = createContext<{ store: GitStore; host: GitPanelHost } | null>(null)
const CODE_HOST: GitPanelHost = Object.freeze({})

export function GitProvider({
  store,
  host,
  children
}: {
  store: GitStore
  host: GitPanelHost
  children: ReactNode
}): JSX.Element {
  return <GitContext.Provider value={{ store, host }}>{children}</GitContext.Provider>
}

export function useGitActions(): GitStore {
  return useContext(GitContext)?.store ?? codeGitStore
}
export function useGitStore(): ReturnType<GitStore['getGitState']> {
  return useGitActions().useGitStore()
}
export function useGitHost(): GitPanelHost {
  return useContext(GitContext)?.host ?? CODE_HOST
}
