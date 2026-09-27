import { useCallback, useMemo, useState, type JSX } from 'react'
import {
  PROVIDERS,
  detectCapabilities,
  testModel,
  updateModel,
  type EngineModel,
  type ModelCapabilities
} from '@renderer/core/engine/models'
import { addModel, refreshModels } from '@renderer/core/engine/model-store'
import { Dialog } from '@renderer/workbench/Dialog'

interface ModelFormDialogProps {
  /** 传入则为编辑模式，不传为新增 */
  model?: EngineModel
  onClose: () => void
  onSaved?: (model: EngineModel) => void
}

interface FormState {
  provider: string
  displayName: string
  modelId: string
  baseUrl: string
  apiKey: string
  /** 图片输入能力（→ capabilities.vision，引擎据此决定是否接受多模态附件） */
  vision: boolean
  /**
   * 思考模式（→ capabilities.thinking）。
   *
   * 三态而非布尔：引擎的 thinkingMode 是「不传 = 跟随模型默认」，
   * 传 false 才会强制关闭。用 null 表达「不传」，避免把用户的
   * 「没表态」误写成「关闭」。
   */
  thinking: boolean | null
}

const EMPTY_FORM: FormState = {
  provider: 'deepseek',
  displayName: '',
  modelId: '',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  vision: false,
  thinking: null
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

  const [form, setForm] = useState<FormState>(() =>
    model
      ? {
          provider: model.provider,
          displayName: model.displayName ?? '',
          modelId: model.modelId,
          baseUrl: model.baseUrl,
          // 编辑时不回填脱敏串，留空即表示不修改
          apiKey: '',
          vision: model.capabilities?.vision === true,
          thinking:
            model.capabilities?.thinking === true
              ? true
              : model.capabilities?.thinking === false
                ? false
                : null
        }
      : EMPTY_FORM
  )

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

  const patch = (next: Partial<FormState>): void => {
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
   * 表单里的能力开关 → 引擎 capabilities。
   *
   * 只写用户明确表态过的键：全 null/未勾选时返回 undefined，
   * 让引擎继续走内置规则推断，而不是被一份空 capabilities 覆盖成「全不支持」。
   */
  const buildCapabilities = useCallback((): ModelCapabilities | undefined => {
    const caps: ModelCapabilities = {}
    if (form.vision) caps.vision = true
    if (form.thinking !== null) caps.thinking = form.thinking
    return Object.keys(caps).length > 0 ? caps : undefined
  }, [form.vision, form.thinking])

  const save = async (): Promise<void> => {
    if (validation) {
      setError(validation)
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (isEdit) {
        await updateModel(model!.id, {
          // 始终传字符串：传 undefined 会被 JSON 序列化丢掉，
          // 引擎侧 `!== undefined` 判断为假，导致「清空显示名称」无法生效
          displayName: form.displayName.trim(),
          baseUrl: form.baseUrl.trim(),
          capabilities: buildCapabilities() ?? null,
          // 留空表示不改 key，不能传空串否则会被引擎校验拒绝
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
        })
        await refreshModels()
        onSaved?.(model!)
      } else {
        const created = await addModel({
          provider: form.provider,
          modelId: form.modelId.trim(),
          apiKey: form.apiKey.trim(),
          baseUrl: form.baseUrl.trim(),
          displayName: form.displayName.trim() || undefined,
          capabilities: buildCapabilities()
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
      <label className="field">
        <span className="field__label">服务商</span>
        <select
          className="field__input"
          value={form.provider}
          disabled={isEdit}
          onChange={(event) => changeProvider(event.target.value)}
        >
          {PROVIDERS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        {providerMeta?.hint ? <small className="field__hint">{providerMeta.hint}</small> : null}
      </label>

      <label className="field">
        <span className="field__label">显示名称（可选）</span>
        <input
          className="field__input"
          value={form.displayName}
          placeholder="列表中展示的名字，留空则显示模型 ID"
          onChange={(event) => patch({ displayName: event.target.value })}
        />
      </label>

      <label className="field">
        <span className="field__label">模型 ID</span>
        <input
          className="field__input"
          value={form.modelId}
          placeholder="如 deepseek-chat"
          disabled={isEdit}
          onChange={(event) => patch({ modelId: event.target.value })}
        />
        {MODEL_PRESETS[form.provider]?.length && !isEdit ? (
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
        ) : null}
      </label>

      <label className="field">
        <span className="field__label">接口地址</span>
        <input
          className="field__input"
          value={form.baseUrl}
          placeholder="https://api.deepseek.com"
          onChange={(event) => patch({ baseUrl: event.target.value })}
        />
        <small className="field__hint">必须是公网可访问地址（引擎会拒绝内网与本机地址）</small>
      </label>

      <label className="field">
        <span className="field__label">API Key</span>
        <input
          className="field__input"
          type="password"
          value={form.apiKey}
          placeholder={
            isEdit ? `留空表示不修改（当前 ${model?.apiKey || '未设置'}）` : '以 sk- 开头的密钥'
          }
          onChange={(event) => patch({ apiKey: event.target.value })}
        />
        {isEdit ? (
          <small className="field__hint">
            仅在你更换了密钥时填写。密钥由引擎加密存储，界面只显示尾号。
          </small>
        ) : null}
      </label>

      <div className="field">
        <span className="field__label">支持图片输入</span>
        <span className="radio-row">
          <label className="radio">
            <input
              type="radio"
              name="vision"
              checked={form.vision}
              onChange={() => patch({ vision: true })}
            />
            支持
          </label>
          <label className="radio">
            <input
              type="radio"
              name="vision"
              checked={!form.vision}
              onChange={() => patch({ vision: false })}
            />
            不支持
          </label>
        </span>
        <small className="field__hint">
          声明该模型可接收图片附件。引擎据此决定是否把图片按多模态下发。
        </small>
      </div>

      <div className="field">
        <span className="field__label">思考模式</span>
        <span className="radio-row">
          <label className="radio">
            <input
              type="radio"
              name="thinking"
              checked={form.thinking === null}
              onChange={() => patch({ thinking: null })}
            />
            跟随模型默认
          </label>
          <label className="radio">
            <input
              type="radio"
              name="thinking"
              checked={form.thinking === true}
              onChange={() => patch({ thinking: true })}
            />
            开启
          </label>
          <label className="radio">
            <input
              type="radio"
              name="thinking"
              checked={form.thinking === false}
              onChange={() => patch({ thinking: false })}
            />
            关闭
          </label>
        </span>
        <small className="field__hint">
          开启后引擎会注入推理参数（DeepSeek 走 reasoning_effort，Qwen 走 enable_thinking）。
          模型本身不支持推理时，引擎按默认行为处理。
        </small>
      </div>

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
        <div className="field">
          <span className="field__label">推断能力</span>
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
          <small className="field__hint">仅作参考，引擎会在每次请求时自行解析</small>
        </div>
      ) : null}

      {error ? <div className="notice notice--error">{error}</div> : null}
    </Dialog>
  )
}
