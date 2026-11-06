import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import {
  PROVIDERS,
  detectCapabilities,
  testModel,
  type EngineModel,
  type ModelCapabilities
} from '@renderer/core/engine/models'
import {
  initialModelForm,
  findModelConflict,
  buildModelUpdate,
  newModelOverrides,
  parseContextWindow,
  type ModelFormState
} from '@renderer/core/engine/model-form'
import { addModel, getModelState, refreshModels, saveModel, useModels } from '@renderer/core/engine/model-store'
import { MODEL_CONFLICT_MESSAGE, ModelAlreadyExistsError } from '@renderer/core/engine/model-save-error'
import { Dialog } from '@renderer/workbench/Dialog'
import { useMotionDismiss } from '@renderer/workbench/MotionPresence'
import { Select } from '@renderer/workbench/Select'
import { Segmented, SettingsContent, SettingsGroup, SettingsRow } from '../settings/SettingsGroup'
import { ContextWindowInput } from './ContextWindowInput'
import './model-form.css'

interface ModelFormDialogProps {
  /** 传入则为编辑模式，不传为新增 */
  model?: EngineModel
  onClose: () => void
  onSaved?: (model: EngineModel) => void
}

export function ModelFormDialog({ model, onClose: dismiss, onSaved }: ModelFormDialogProps): JSX.Element {
  const { show, close: onClose } = useMotionDismiss(dismiss)
  const [existingToEdit, setExistingToEdit] = useState<EngineModel | undefined>()
  const editingModel = model ?? existingToEdit
  const isEdit = Boolean(editingModel)
  const { models, loading } = useModels()
  const conflictId = useId()
  const modelIdInput = useRef<HTMLInputElement>(null)
  const displayNameInput = useRef<HTMLInputElement>(null)
  const feedbackRef = useRef<HTMLDivElement>(null)
  // State alone cannot stop two Enter/click handlers before React commits.
  const saveInFlight = useRef(false)

  const [form, setForm] = useState<ModelFormState>(() => initialModelForm(model))

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testOk, setTestOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverConflict, setServerConflict] = useState<ModelAlreadyExistsError | null>(null)
  const [caps, setCaps] = useState<ModelCapabilities | null>(null)
  const duplicate = !isEdit ? findModelConflict(models, form) : undefined
  const hasConflict = !isEdit && Boolean(duplicate || serverConflict)
  useEffect(() => {
    if (serverConflict && !saving) modelIdInput.current?.focus()
  }, [serverConflict, saving])
  useEffect(() => {
    if (existingToEdit) displayNameInput.current?.focus()
  }, [existingToEdit])
  useEffect(() => {
    // Footer actions remain reachable while the feedback is below the fold.
    if (testResult || caps || error) feedbackRef.current?.scrollIntoView({ block: 'nearest' })
  }, [testResult, caps, error])

  const providerMeta = useMemo(
    () => PROVIDERS.find((item) => item.value === form.provider),
    [form.provider]
  )

  const patch = (next: Partial<ModelFormState>): void => {
    if (saveInFlight.current) return
    setForm((prev) => ({ ...prev, ...next }))
    setTestResult(null)
    setError(null)
    if (next.modelId !== undefined || next.provider !== undefined) setServerConflict(null)
  }

  /** 切换 Provider 时同步推荐 baseUrl（仅当当前值仍是上一个 Provider 的默认值） */
  const changeProvider = (value: string): void => {
    if (saveInFlight.current) return
    const previousDefault = providerMeta?.baseUrl ?? ''
    const nextDefault = PROVIDERS.find((item) => item.value === value)?.baseUrl ?? ''
    setForm((prev) => ({
      ...prev,
      provider: value,
      baseUrl: !prev.baseUrl || prev.baseUrl === previousDefault ? nextDefault : prev.baseUrl
    }))
    setTestResult(null)
    setError(null)
    setServerConflict(null)
  }

  const editExisting = (): void => {
    if (!duplicate || saveInFlight.current) return
    // This explicit action opens the saved record with an empty key field.
    // Never merge the failed create draft into the existing credentials.
    setExistingToEdit(duplicate)
    setForm(initialModelForm(duplicate))
    setServerConflict(null)
    setError(null)
    setTestResult(null)
    setCaps(null)
  }

  const refreshConflicts = async (): Promise<void> => {
    if (saveInFlight.current) return
    await refreshModels()
    const state = getModelState()
    if (!state.error) setServerConflict(null)
    else setError('模型列表刷新失败，请稍后重试。')
  }

  // 表单校验：与服务端规则保持一致，提前拦截避免无谓请求
  const validation = useMemo((): string | null => {
    if (!form.modelId.trim()) return '请填写模型 ID'
    if (!form.baseUrl.trim()) return '请填写接口地址'
    try {
      const url = new URL(form.baseUrl.trim())
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return '接口地址必须是 http(s) 链接'
      // 引擎侧会拒绝私网地址，这里提前说明，避免用户拿到一个笼统的 400
      if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|localhost)/i.test(url.hostname)) {
        return '引擎不允许私网/本机地址。本地模型请改用引擎的 OLLAMA_BASE_URL 等配置'
      }
    } catch {
      return '接口地址格式不正确'
    }
    if (!isEdit) {
      if (!form.apiKey.trim()) return '请填写 API Key'
      if (form.apiKey.trim().length < 16) return 'API Key 至少 16 个字符'
    } else if (form.apiKey.trim() && form.apiKey.trim().length < 16) {
      return 'API Key 至少 16 个字符'
    }
    try {
      parseContextWindow(form.contextWindow)
    } catch (error) {
      return error instanceof Error ? error.message : '上下文窗口无效'
    }
    return null
  }, [form, isEdit])

  const runTest = async (): Promise<void> => {
    if (validation) {
      setError(validation)
      return
    }

    setTesting(true)
    setTestResult(null)
    // Reuse the saved key while testing the current draft URL and wire format.
    const result = await testModel(isEdit && !form.apiKey.trim() ? editingModel!.id : 'new', {
      provider: form.provider,
      modelId: form.modelId.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      baseUrl: form.baseUrl.trim(),
      apiFormat: form.apiFormat
    })
    setTesting(false)
    setTestOk(result.success)
    setTestResult(
      result.success
        ? `连接正常（${result.latency ?? '-'} ms）${result.thinkingSupported ? ' · 支持推理输出' : ''}`
        : `失败：${result.error ?? '未知错误'}`
    )
  }

  const runDetect = async (): Promise<void> => {
    if (!form.modelId.trim()) {
      setError('请先填写模型 ID')
      return
    }
    try {
      setCaps(
        await detectCapabilities({
          provider: form.provider,
          modelId: form.modelId.trim(),
          baseUrl: form.baseUrl.trim(),
          apiFormat: form.apiFormat
        })
      )
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 文本输入框回车即提交（对齐 PromptDialog）。
   * 中文输入法组合期间的回车属于确认候选词，不能当作提交。
   */
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
    }
  }

  const save = async (): Promise<void> => {
    if (saveInFlight.current) return
    if (hasConflict) {
      modelIdInput.current?.focus()
      return
    }
    if (validation) {
      setError(validation)
      return
    }
    saveInFlight.current = true
    setSaving(true)
    setError(null)
    try {
      if (isEdit) {
        const updated = await saveModel(editingModel!.id, buildModelUpdate(editingModel!, form))
        onSaved?.(updated)
      } else {
        const created = await addModel({
          provider: form.provider,
          modelId: form.modelId.trim(),
          apiKey: form.apiKey.trim(),
          baseUrl: form.baseUrl.trim(),
          apiFormat: form.apiFormat,
          displayName: form.displayName.trim() || undefined,
          capabilityOverrides: newModelOverrides(form)
        })
        onSaved?.(created)
      }
      onClose()
    } catch (err) {
      if (!isEdit && err instanceof ModelAlreadyExistsError) {
        setServerConflict(err)
        modelIdInput.current?.focus()
        // A different window may have created the record after our cached list.
        // Refresh only for recovery; this never retries or converts POST into PUT.
        void refreshModels()
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={show}
      className="modal--model-form"
      title={isEdit ? '编辑模型' : '添加模型'}
      footer={
        <>
          <div className="model-form__secondary-actions">
            <button type="button" className="btn" disabled={testing || saving} onClick={() => void runTest()}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button type="button" className="btn" disabled={saving} onClick={() => void runDetect()}>
              检测能力
            </button>
          </div>
          <div className="model-form__primary-actions">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={saving || hasConflict || Boolean(validation)}
              title={hasConflict ? MODEL_CONFLICT_MESSAGE : validation ?? undefined}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </>
      }
      onClose={onClose}
    >
      <SettingsGroup title="基本信息">
        <SettingsRow label="服务商" description={providerMeta?.hint}>
          <Select
            className="sg__select-field"
            panelClassName="model-form__popover"
            ariaLabel="服务商"
            value={form.provider}
            disabled={isEdit || saving}
            options={PROVIDERS.map((item) => ({ value: item.value, label: item.label }))}
            onChange={changeProvider}
          />
        </SettingsRow>
        <SettingsRow label="显示名称" description="列表中展示的名字，留空则显示模型 ID">
          <input
            ref={displayNameInput}
            className="field__input sg__input sg__input--wide"
            value={form.displayName}
            aria-label="显示名称"
            disabled={saving}
            placeholder="可选"
            onChange={(event) => patch({ displayName: event.target.value })}
            onKeyDown={submitOnEnter}
          />
        </SettingsRow>
        <SettingsRow label="模型 ID">
          <input
            ref={modelIdInput}
            className="field__input sg__input sg__input--wide"
            value={form.modelId}
            placeholder="如 deepseek-chat"
            aria-label="模型 ID"
            aria-invalid={hasConflict || undefined}
            aria-describedby={hasConflict ? conflictId : undefined}
            disabled={isEdit || saving}
            onChange={(event) => patch({ modelId: event.target.value })}
            onKeyDown={submitOnEnter}
          />
        </SettingsRow>
        {hasConflict ? (
          <SettingsContent>
            <div id={conflictId} role="alert" className="notice notice--error">
              <div>{MODEL_CONFLICT_MESSAGE}</div>
              <span className="chip-row">
                {duplicate ? (
                  <button type="button" className="btn btn--sm" onClick={editExisting}>
                    编辑已有模型
                  </button>
                ) : null}
                <button type="button" className="btn btn--sm" disabled={loading || saving} onClick={() => void refreshConflicts()}>
                  {loading ? '刷新中…' : '刷新模型列表'}
                </button>
              </span>
            </div>
          </SettingsContent>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="连接">
        <SettingsRow
          label="接口地址"
          description="必须是公网可访问地址（引擎会拒绝内网与本机地址）"
        >
          <input
            className="field__input sg__input sg__input--wide"
            value={form.baseUrl}
            aria-label="接口地址"
            disabled={saving}
            placeholder="https://api.deepseek.com"
            onChange={(event) => patch({ baseUrl: event.target.value })}
            onKeyDown={submitOnEnter}
          />
        </SettingsRow>
        <SettingsRow
          label="API 格式"
          description="默认按服务商和地址识别；第三方网关可手动指定，以所选格式为准"
        >
          <Select
            className="sg__select-field"
            panelClassName="model-form__popover"
            ariaLabel="API 格式"
            value={form.apiFormat}
            disabled={saving}
            options={[
              { value: 'auto', label: '自动识别' },
              { value: 'openai', label: 'OpenAI', description: 'Chat Completions 格式' },
              { value: 'anthropic', label: 'Anthropic', description: 'Messages 格式' }
            ]}
            onChange={(value) => {
              if (value === 'auto' || value === 'openai' || value === 'anthropic') patch({ apiFormat: value })
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="API Key"
          description={isEdit ? '仅在更换密钥时填写，留空表示不修改' : undefined}
        >
          <input
            className="field__input sg__input sg__input--wide"
            type="password"
            aria-label="API Key"
            disabled={saving}
            value={form.apiKey}
            placeholder={
              isEdit ? `留空表示不修改（当前 ${editingModel?.apiKey || '未设置'}）` : '以 sk- 开头的密钥'
            }
            onChange={(event) => patch({ apiKey: event.target.value })}
            onKeyDown={submitOnEnter}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="能力">
        <SettingsRow
          label="支持图片输入"
          description="默认跟随模型能力；开启或关闭会保存为人工设置"
        >
          <div role="group" aria-label="图片输入能力">
            <Segmented
              disabled={saving}
              options={[
                { value: 'default', label: '默认' },
                { value: 'on', label: '开启' },
                { value: 'off', label: '关闭' }
              ]}
              value={form.vision === null ? 'default' : form.vision ? 'on' : 'off'}
              onChange={(value) => patch({ vision: value === 'default' ? null : value === 'on' })}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label="思考模式"
          description="开启后引擎会注入推理参数（DeepSeek 走 reasoning_effort，Qwen 走 enable_thinking）；模型不支持时按默认行为处理"
        >
          <div role="group" aria-label="思考能力">
            <Segmented
              disabled={saving}
              options={[
                { value: 'default', label: '默认' },
                { value: 'on', label: '开启' },
                { value: 'off', label: '关闭' }
              ]}
              value={form.thinking === null ? 'default' : form.thinking ? 'on' : 'off'}
              onChange={(value) =>
                patch({ thinking: value === 'default' ? null : value === 'on' ? true : false })
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label="上下文窗口"
          description="可选择或自由输入，留空自动识别。1 K = 1000 token，最多三位小数；实际使用还受上下文预算约束"
        >
          <ContextWindowInput
            value={form.contextWindow}
            disabled={saving}
            onChange={(contextWindow) => patch({ contextWindow })}
            onSubmit={submitOnEnter}
          />
        </SettingsRow>
      </SettingsGroup>

      {testResult || caps || error ? (
        <div ref={feedbackRef} className="model-form__feedback">
          {testResult ? (
            <div role="status" className={testOk ? 'notice notice--ok' : 'notice notice--error'}>{testResult}</div>
          ) : null}

          {caps ? (
            <SettingsGroup title="推断能力" footer="仅作参考，引擎会在每次请求时自行解析">
              <SettingsContent>
                <span className="chip-row">
                  {Object.entries(caps)
                    .filter(([, enabled]) => enabled)
                    .map(([key]) => (
                      <span key={key} className="chip chip--static">
                        {key}
                      </span>
                    ))}
                  {Object.values(caps).every((value) => !value) ? (
                    <small className="field__hint">未匹配到已知能力，将按基础模型处理</small>
                  ) : null}
                </span>
                <span className="chip-row">
                  {caps.vision ? (
                    <button
                      type="button"
                      className="chip"
                      disabled={saving}
                      title="把推断出的「图像理解」填入上方开关"
                      onClick={() => patch({ vision: true })}
                    >
                      → 填入图片输入
                    </button>
                  ) : null}
                  {caps.thinking ? (
                    <button
                      type="button"
                      className="chip"
                      disabled={saving}
                      title="把推断出的「推理模式」填入上方开关"
                      onClick={() => patch({ thinking: true })}
                    >
                      → 填入思考模式
                    </button>
                  ) : null}
                </span>
              </SettingsContent>
            </SettingsGroup>
          ) : null}

          {error ? <div role="alert" className="notice notice--error">{error}</div> : null}
        </div>
      ) : null}
    </Dialog>
  )
}
