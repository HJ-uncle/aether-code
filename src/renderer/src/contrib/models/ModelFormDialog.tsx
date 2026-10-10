import { useMemo, useState, type JSX, type KeyboardEvent } from 'react'
import {
  PROVIDERS,
  detectCapabilities,
  testModel,
  type EngineModel,
  type ModelCapabilities
} from '@renderer/core/engine/models'
import {
  initialModelForm,
  buildModelUpdate,
  newModelOverrides,
  parseContextWindow,
  type ModelFormState
} from '@renderer/core/engine/model-form'
import { addModel, saveModel } from '@renderer/core/engine/model-store'
import { Dialog } from '@renderer/workbench/Dialog'
import { Select } from '@renderer/workbench/Select'
import { Segmented, SettingsContent, SettingsGroup, SettingsRow } from '../settings/SettingsGroup'

interface ModelFormDialogProps {
  /** 传入则为编辑模式，不传为新增 */
  model?: EngineModel
  onClose: () => void
  onSaved?: (model: EngineModel) => void
}

/** 常见的 modelId 预设，减少手输错误 */
const MODEL_PRESETS: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
  qwen: ['qwen-plus', 'qwen-max', 'qwen3-coder-plus']
}

export function ModelFormDialog({ model, onClose, onSaved }: ModelFormDialogProps): JSX.Element {
  const isEdit = Boolean(model)

  const [form, setForm] = useState<ModelFormState>(() => initialModelForm(model))

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testOk, setTestOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [caps, setCaps] = useState<ModelCapabilities | null>(null)

  const providerMeta = useMemo(
    () => PROVIDERS.find((item) => item.value === form.provider),
    [form.provider]
  )

  const patch = (next: Partial<ModelFormState>): void => {
    setForm((prev) => ({ ...prev, ...next }))
    setTestResult(null)
    setError(null)
  }

  /** 切换 Provider 时同步推荐 baseUrl（仅当当前值仍是上一个 Provider 的默认值） */
  const changeProvider = (value: string): void => {
    const previousDefault = providerMeta?.baseUrl ?? ''
    const nextDefault = PROVIDERS.find((item) => item.value === value)?.baseUrl ?? ''
    setForm((prev) => ({
      ...prev,
      provider: value,
      baseUrl: !prev.baseUrl || prev.baseUrl === previousDefault ? nextDefault : prev.baseUrl
    }))
    setTestResult(null)
    setError(null)
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
    if (isEdit && !form.apiKey.trim()) {
      // 用已保存的配置测试
      setTesting(true)
      setTestResult(null)
      const result = await testModel(model!.id)
      setTesting(false)
      setTestOk(result.success)
      setTestResult(
        result.success
          ? `连接正常（${result.latency ?? '-'} ms）${result.thinkingSupported ? ' · 支持推理输出' : ''}`
          : `失败：${result.error ?? '未知错误'}`
      )
      return
    }

    if (validation) {
      setError(validation)
      return
    }

    setTesting(true)
    setTestResult(null)
    const result = await testModel('new', {
      provider: form.provider,
      modelId: form.modelId.trim(),
      apiKey: form.apiKey.trim(),
      baseUrl: form.baseUrl.trim()
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
          baseUrl: form.baseUrl.trim()
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
    if (validation) {
      setError(validation)
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (isEdit) {
        const updated = await saveModel(model!.id, buildModelUpdate(model!, form))
        onSaved?.(updated)
      } else {
        const created = await addModel({
          provider: form.provider,
          modelId: form.modelId.trim(),
          apiKey: form.apiKey.trim(),
          baseUrl: form.baseUrl.trim(),
          displayName: form.displayName.trim() || undefined,
          capabilityOverrides: newModelOverrides(form)
        })
        onSaved?.(created)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={isEdit ? '编辑模型' : '添加模型'}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={saving || Boolean(validation)}
            title={validation ?? undefined}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
      onClose={onClose}
    >
      <SettingsGroup title="基本信息">
        <SettingsRow label="服务商" description={providerMeta?.hint}>
          <Select
            className="sg__select-field"
            value={form.provider}
            disabled={isEdit}
            options={PROVIDERS.map((item) => ({ value: item.value, label: item.label }))}
            onChange={changeProvider}
          />
        </SettingsRow>
        <SettingsRow label="显示名称" description="列表中展示的名字，留空则显示模型 ID">
          <input
            className="field__input sg__input sg__input--wide"
            value={form.displayName}
            placeholder="可选"
            onChange={(event) => patch({ displayName: event.target.value })}
            onKeyDown={submitOnEnter}
          />
        </SettingsRow>
        <SettingsRow label="模型 ID">
          <input
            className="field__input sg__input sg__input--wide"
            value={form.modelId}
            placeholder="如 deepseek-chat"
            disabled={isEdit}
            onChange={(event) => patch({ modelId: event.target.value })}
            onKeyDown={submitOnEnter}
          />
        </SettingsRow>
        {MODEL_PRESETS[form.provider]?.length && !isEdit ? (
          <SettingsContent>
            <span className="chip-row">
              {MODEL_PRESETS[form.provider].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="chip"
                  onClick={() => patch({ modelId: preset })}
                >
                  {preset}
                </button>
              ))}
            </span>
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
            placeholder="https://api.deepseek.com"
            onChange={(event) => patch({ baseUrl: event.target.value })}
            onKeyDown={submitOnEnter}
          />
        </SettingsRow>
        <SettingsRow
          label="API Key"
          description={isEdit ? '仅在更换密钥时填写，留空表示不修改' : undefined}
        >
          <input
            className="field__input sg__input sg__input--wide"
            type="password"
            value={form.apiKey}
            placeholder={
              isEdit ? `留空表示不修改（当前 ${model?.apiKey || '未设置'}）` : '以 sk- 开头的密钥'
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
          description="单位 K（1K = 1000 token），可保留三位小数；留空则跟随引擎识别结果"
        >
          <input
            className="field__input sg__input sg__input--wide"
            value={form.contextWindow}
            placeholder="如 128"
            inputMode="decimal"
            onChange={(event) => patch({ contextWindow: event.target.value })}
            onKeyDown={submitOnEnter}
          />
        </SettingsRow>
      </SettingsGroup>

      <div className="settings-view__actions">
        <button type="button" className="btn" disabled={testing} onClick={() => void runTest()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button type="button" className="btn" onClick={() => void runDetect()}>
          检测能力
        </button>
      </div>

      {testResult ? (
        <div className={testOk ? 'notice notice--ok' : 'notice notice--error'}>{testResult}</div>
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

      {error ? <div className="notice notice--error">{error}</div> : null}
    </Dialog>
  )
}
