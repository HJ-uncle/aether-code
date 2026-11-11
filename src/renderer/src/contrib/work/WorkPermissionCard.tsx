import { useId, useMemo, useRef, useState, type JSX } from 'react'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { useModels } from '@renderer/core/engine/model-store'
import { Icon } from '@renderer/workbench/icons'
import { permissionPresentation, type PermissionSection } from './work-permission-presentation'
import { groupAgentTools } from './work-agent-tool-groups'
import './work-permission-card.css'

interface Props {
  pending: PendingInteraction
  blocked: boolean
  submitting: 'reply' | 'full-access' | null
  onReply: (values: string[], fullAccess?: boolean) => void
}

interface DetailPage {
  id: string
  label: string
  count?: number
  sections: PermissionSection[]
}

function ToolList({ entries }: { entries: Array<{ id: string; label: string }> }): JSX.Element {
  return (
    <div className="work-permission__tool-groups">
      {groupAgentTools(entries).map((group) => (
        <section className="work-permission__tool-group" key={group.id}>
          <h5>
            {group.label}
            <span>{group.options.length}</span>
          </h5>
          <ul>
            {group.options.map((tool, index) => (
              <li key={tool.id + index} title={tool.id}>
                {tool.label}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function DetailContent({ section }: { section: PermissionSection }): JSX.Element {
  return (
    <div className="work-permission__detail-content" data-section={section.id}>
      {section.previous !== undefined ? (
        <div className="work-permission__before">
          <h5>修改前</h5>
          {section.previousEntries?.length ? (
            <ToolList entries={section.previousEntries} />
          ) : (
            <p>{section.previous}</p>
          )}
        </div>
      ) : null}
      {section.previous !== undefined ? <h5>修改后</h5> : null}
      {section.text !== undefined ? <p>{section.text}</p> : null}
      {section.entries ? (
        <ToolList entries={section.entries} />
      ) : section.items ? (
        <ul className="work-permission__resource-list">
          {section.items.map((item, index) => (
            <li key={item + index}>{item}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** One inspector panel at a time keeps both navigation and the decision within reach. */
export function WorkPermissionCard({ pending, blocked, submitting, onReply }: Props): JSX.Element {
  const presentation = useMemo(() => permissionPresentation(pending), [pending])
  const { models } = useModels()
  const titleId = useId(),
    panelId = useId()
  const [selectedPage, setSelectedPage] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const modelLabel = (value: string): string => {
    const model = models.find((item) => item.id === value || item.modelId === value)
    return model?.displayName || model?.modelId || value
  }
  const description = presentation.fields.find(
    (field) => field.label === '用途' && field.previous === undefined
  )
  const metadata = presentation.fields.filter(
    (field) => ['模型', '温度'].includes(field.label) && field.previous === undefined
  )
  const fields = presentation.fields.filter(
    (field) => field !== description && !metadata.includes(field)
  )
  const commands = presentation.sections.filter((section) => section.id === 'command')
  const resources = presentation.sections.filter((section) =>
    ['skills', 'mcpServers', 'knowledgeBases'].includes(section.id)
  )
  const instructions = presentation.sections.filter((section) => section.id === 'systemPrompt')
  const tools = presentation.sections.filter((section) => section.id === 'allowedTools')
  const extra = presentation.sections.filter(
    (section) => ![...commands, ...resources, ...instructions, ...tools].includes(section)
  )
  const pages: DetailPage[] = [
    ...(instructions.length
      ? [{ id: 'instructions', label: '工作指令', sections: instructions }]
      : []),
    ...(resources.length
      ? [
          {
            id: 'resources',
            label: '资源',
            count: resources.reduce((sum, section) => sum + (section.items?.length ?? 0), 0),
            sections: resources
          }
        ]
      : []),
    ...(tools.length
      ? [{ id: 'tools', label: '工具权限', count: tools[0].items?.length, sections: tools }]
      : []),
    ...(extra.length ? [{ id: 'other', label: '更多详情', sections: extra }] : [])
  ]
  const activePage =
    selectedPage === 'raw' || pages.some((page) => page.id === selectedPage)
      ? selectedPage
      : (pages[0]?.id ?? 'raw')
  const currentPage = pages.find((page) => page.id === activePage)
  const selectPage = (id: string): void => {
    if (id === activePage) return
    setSelectedPage(id)
    // A previous long section must not leave the next section scrolled past its heading.
    if (panel.current) panel.current.scrollTop = 0
  }
  const options = [...pending.options].sort(
    (a, b) => Number(a.value === 'approved') - Number(b.value === 'approved')
  )
  return (
    <div className="work-permission" aria-labelledby={titleId}>
      <header
        className={`work-permission__header${presentation.destructive ? ' is-destructive' : ''}`}
      >
        <Icon
          name={
            presentation.destructive
              ? 'trash'
              : /^agent_(?:do_)?/.test(pending.toolName)
                ? 'agent-general'
                : 'shield'
          }
          size={18}
        />
        <h3 id={titleId}>{presentation.title}</h3>
      </header>
      <div className="work-permission__overview">
        {presentation.summary ? (
          <p className="work-permission__summary">{presentation.summary}</p>
        ) : null}
        {description ? <p className="work-permission__description">{description.value}</p> : null}
        {fields.length ? (
          <dl className="work-permission__fields">
            {fields.map((field, index) => (
              <div className="work-permission__field" key={field.label + index}>
                <dt>{field.label}</dt>
                <dd>
                  {field.previous !== undefined ? (
                    <span className="work-permission__previous">
                      <span>原值</span>
                      {field.label === '模型' ? modelLabel(field.previous) : field.previous}
                    </span>
                  ) : null}
                  <span>{field.label === '模型' ? modelLabel(field.value) : field.value}</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {metadata.length ? (
          <dl className="work-permission__metadata">
            {metadata.map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd title={field.value}>
                  {field.label === '模型' ? modelLabel(field.value) : field.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {presentation.reason ? (
          <p className="work-permission__reason">{presentation.reason}</p>
        ) : null}
        {commands.map((section) => (
          <pre className="work-permission__command" aria-label={section.label} key={section.id}>
            {section.text}
          </pre>
        ))}
      </div>

      <div className="work-permission__inspector">
        <div className="work-permission__detailbar" role="group" aria-label="配置详情">
          {pages.length ? (
            <div className="work-permission__segments">
              {pages.map((page) => (
                <button
                  type="button"
                  key={page.id}
                  aria-label={page.label}
                  aria-expanded={activePage === page.id}
                  aria-controls={panelId}
                  className={activePage === page.id ? 'is-selected' : ''}
                  onClick={() => selectPage(page.id)}
                >
                  {page.label}
                  {page.count !== undefined ? <span aria-hidden="true">{page.count}</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <span className="work-permission__detailbar-label">操作详情</span>
          )}
          <button
            type="button"
            className={`work-permission__more${activePage === 'raw' ? ' is-selected' : ''}`}
            aria-label="完整参数"
            title="完整参数"
            aria-expanded={activePage === 'raw'}
            aria-controls={panelId}
            onClick={() => selectPage('raw')}
          >
            <Icon name="dots-horizontal" size={18} />
          </button>
        </div>
        {activePage && (currentPage || activePage === 'raw') ? (
          <div
            ref={panel}
            id={panelId}
            className="work-permission__body"
            role="region"
            aria-label="操作详情"
            tabIndex={0}
          >
            {activePage === 'raw' ? (
              <pre className="work-permission__raw">{presentation.raw}</pre>
            ) : (
              currentPage?.sections.map((section) => (
                <section
                  className="work-permission__section"
                  key={section.id}
                  aria-label={section.label}
                >
                  {currentPage.sections.length > 1 ||
                  currentPage.id === 'resources' ||
                  currentPage.id === 'other' ? (
                    <h4>{section.label}</h4>
                  ) : null}
                  <DetailContent section={section} />
                </section>
              ))
            )}
          </div>
        ) : null}
      </div>

      <footer className="work-permission__footer">
        <button
          type="button"
          className="work-permission__access"
          disabled={blocked}
          aria-label="本会话改为完全访问并放行"
          title="仅对本会话生效：后续命令不再询问，并放行当前操作；同时解除工作区路径限制"
          onClick={() => onReply(['approved'], true)}
        >
          <Icon name="shield" size={14} />
          {submitting === 'full-access' ? '切换并放行中…' : '完全访问并放行'}
        </button>
        <div className="work-permission__decisions">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`btn${option.value === 'approved' ? (presentation.destructive ? ' btn--danger' : ' btn--primary') : ''}`}
              disabled={blocked}
              title={option.description}
              onClick={() => onReply([option.value])}
            >
              {option.value === 'approved' ? presentation.confirmLabel : option.label}
            </button>
          ))}
        </div>
      </footer>
    </div>
  )
}
