import type { EngineRequestResult } from '@shared/ipc'

export const MODEL_CONFLICT_MESSAGE = '该服务商下已存在相同模型 ID，请编辑已有模型或使用其他模型 ID。'

export class ModelAlreadyExistsError extends Error {
  constructor(readonly existingModelId?: string) {
    super(MODEL_CONFLICT_MESSAGE)
    this.name = 'ModelAlreadyExistsError'
  }
}

/** HTTP bridges may preserve either the business code or HTTP status. The
 * structured reason is authoritative; old engines need one narrowly scoped fallback. */
export function modelSaveError(result: Pick<EngineRequestResult<unknown>, 'code' | 'message' | 'data'>, fallback: string): Error {
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : undefined
  const legacyConflict = /UNIQUE constraint failed:\s*models\.tenant_id,\s*models\.provider,\s*models\.model_id\b/i.test(result.message)
  if (data?.reason === 'MODEL_ALREADY_EXISTS' || result.code === 40901 || legacyConflict) {
    return new ModelAlreadyExistsError(
      typeof data?.existingModelId === 'string' && data.existingModelId.trim()
        ? data.existingModelId
        : undefined
    )
  }
  // Database implementation details do not give the user a useful recovery action.
  return new Error(/SQLITE_|SQLSTATE|constraint failed/i.test(result.message) ? fallback : result.message || fallback)
}
