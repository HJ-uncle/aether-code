import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { assertAllowed } from '../fs/file-service'
import { withRepositoryLease, physicalRepositoryLock, repositoryLeaseStatus, recoverRepositoryLease, activeCloneRepositoryLease } from './repository-lease'
import type { RepositoryProcessScope } from './repository-process'

interface Operation { lock: string; scope: RepositoryProcessScope; assertOwned:()=>void }
const operations=new AsyncLocalStorage<Operation>()

/** Keep compound actions (stage+commit, pull+push, multi-file discard) under
 * one lease. Per-command locks would admit another task between those steps. */
export async function withMainGitOperation<T>(cwd: string, action:()=>Promise<T>, read=false, prepareInit=false): Promise<T> {
  const allowed=assertAllowed(cwd)
  const initializesDirectory=prepareInit && !fs.existsSync(path.join(allowed,'.git'))
  const lock=physicalRepositoryLock(allowed,prepareInit)
  const current=operations.getStore()
  if(current?.lock===lock) {current.assertOwned();return action()}
  try {return await withRepositoryLease(lock,(scope,assertOwned)=>operations.run({lock,scope,assertOwned},action),read?30_000:0)}
  catch(error) {if(initializesDirectory)throw Object.assign(error instanceof Error?error:new Error(String(error)),{executionDisposition:'may_have_effects'});throw error}
}
export function mainGitProcessScope(): RepositoryProcessScope {
  const current=operations.getStore()
  if(!current)throw new Error('Git command was dispatched without an operation lease')
  current.assertOwned();return current.scope
}
export function mainGitLeaseStatus(cwd: string) {const safe=assertAllowed(cwd);return repositoryLeaseStatus(activeCloneRepositoryLease(safe)??physicalRepositoryLock(safe))}
export function recoverMainGitLease(cwd: string, generation: string) {const safe=assertAllowed(cwd);return recoverRepositoryLease(activeCloneRepositoryLease(safe)??physicalRepositoryLock(safe),generation)}
