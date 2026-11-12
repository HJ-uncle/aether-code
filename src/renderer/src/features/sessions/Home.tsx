import { useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Icon, type IconName } from '@renderer/ui/icons'
import { useHoverDetail } from '@renderer/ui/useHoverDetail'
import type { useSessionController } from './runtime'
import { getSessionDraft, type SessionTask } from './state'
import { Composer } from '../composer/Composer'
import { TaskStatus } from './TaskStatus'
import './home.css'

export type HomeFilter = 'all' | 'running' | 'waiting' | 'done'
const FILTERS = [['all', '全部'], ['running', '进行中'], ['waiting', '需要处理'], ['done', '已完成']] as const
const TEMPLATES: Array<{ title: string; icon: IconName; text: string }> = [
  { title: '调研一个主题', icon: 'search', text: '请帮我调研以下主题，整理关键发现并列出可核对的来源：\n' },
  { title: '起草一份文档', icon: 'pencil', text: '请帮我起草一份文档。目标读者：\n文档主题：\n需要包含：' },
  { title: '分析资料', icon: 'graph', text: '请分析我提供的资料，提取关键数据、变化趋势和需要关注的问题。\n重点关注：' },
  { title: '整理行动计划', icon: 'check-all', text: '请将以下目标整理为清晰的行动计划，列出步骤、依赖和交付物：\n' }
]
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeStyle: 'short' })
const projectName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) || path
const HOME_TASK_PAGE_SIZE = 5

export function Home({ controller, tasks, filter, onFilter, search, onSearch, onOpenTask }: {
  controller: ReturnType<typeof useSessionController>
  tasks: SessionTask[]
  filter: HomeFilter
  onFilter: (filter: HomeFilter) => void
  search: string
  onSearch: (search: string) => void
  onOpenTask: (id: string) => void
}): JSX.Element {
  const composerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const query = search.trim().toLocaleLowerCase()
  const filtered = useMemo(() => tasks.filter(task =>
    (filter === 'all' || task.status === filter) && task.title.toLocaleLowerCase().includes(query)
  ).sort((a, b) => b.updatedAt - a.updatedAt), [tasks, filter, query])
  const waiting = tasks.filter(task => task.status === 'waiting').length
  const insertTemplate = (text: string): void => {
    // Read the live draft so a template cannot overwrite unflushed typing or its references.
    const draft = getSessionDraft(controller.draftSource, null)
    controller.setDraft(draft.text.trim() ? `${draft.text}\n\n${text}` : text, draft.mentions)
    composerRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus()
  }
  const clearSearch = (): void => { onSearch(''); searchRef.current?.focus() }
  return <div className="work-page work-home">
    <div className="work-page__inner work-home__inner">
      <header className="work-home__heading">
        <h1>工作台</h1>
        <p>描述目标，添加资料，开始协作。</p>
      </header>
      <section className="work-home__start" aria-label="开始新任务">
        <div ref={composerRef}><Composer controller={controller} home /></div>
        <div className="work-templates" role="group" aria-label="任务模板">
          {TEMPLATES.map(template => <button type="button" key={template.title}
            title={`将“${template.title}”模板添加到草稿`} onClick={() => insertTemplate(template.text)}>
            <Icon name={template.icon} size={15} /><span>{template.title}</span>
          </button>)}
        </div>
      </section>
      <section className="work-recent" aria-label="最近任务">
        <header className="work-recent__toolbar">
          <div className="work-recent__heading">
            <h2>最近任务</h2>
            <span role="status">{filter !== 'all' || query ? `${filtered.length} / ${tasks.length}` : tasks.length} 项</span>
          </div>
          {tasks.length > 0 && <div className="work-list-tools">
            <div className="work-filters" role="group" aria-label="任务筛选">
              {FILTERS.map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => onFilter(id)}>
                {label}{id === 'waiting' && waiting > 0 ? <span className="work-filters__count">{waiting}</span> : null}
              </button>)}
            </div>
            <label className="work-search ui-input-shell ui-input-shell--compact">
              <Icon name="search" size={14} />
              <input ref={searchRef} className="ui-input-field" type="search" aria-label="搜索 Work 任务" placeholder="搜索任务"
                value={search} onChange={event => onSearch(event.target.value)} onKeyDown={event => {
                  if (event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); clearSearch() }
                }} />
              {search && <button type="button" className="work-search__clear" aria-label="清除任务搜索" onClick={clearSearch}><Icon name="close" size={12} /></button>}
            </label>
          </div>}
          {filtered.length > 0 && <div className="work-recent__columns" aria-hidden="true"><span>任务</span><span>状态</span><span>更新时间</span></div>}
        </header>
        {filtered.length ? <HomeTaskList key={`${filter}:${query}`} tasks={filtered} ready={controller.ready} onOpen={onOpenTask} />
          : <div className="work-home__empty">
            <Icon name={tasks.length ? 'search' : 'chat'} size={24} />
            <strong>{tasks.length ? '没有匹配的任务' : '从一项新任务开始'}</strong>
            <p>{tasks.length ? '试试其他关键词，或查看全部任务。' : '在上方写下目标，任务会自动保存在这里。'}</p>
            {tasks.length > 0 && <button type="button" onClick={() => { onFilter('all'); clearSearch() }}>查看全部任务</button>}
          </div>}
      </section>
    </div>
  </div>
}

function HomeTaskList({ tasks, ready, onOpen }: { tasks: SessionTask[]; ready: boolean; onOpen: (id: string) => void }): JSX.Element {
  const [page, setPage] = useState(0)
  const previousRef = useRef<HTMLButtonElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const keyboardDirection = useRef<'previous' | 'next' | null>(null)
  const pages = Math.ceil(tasks.length / HOME_TASK_PAGE_SIZE)
  const current = Math.min(page, pages - 1)
  const start = current * HOME_TASK_PAGE_SIZE
  useLayoutEffect(() => {
    if (!keyboardDirection.current) return
    const target = keyboardDirection.current === 'previous' ? previousRef.current : nextRef.current
    const alternate = keyboardDirection.current === 'previous' ? nextRef.current : previousRef.current
    // At a page boundary the pressed button becomes disabled; keep focus on a usable paging action.
    if (target?.disabled) alternate?.focus()
    keyboardDirection.current = null
  }, [current])
  return <>
    <ul className="work-task-list" data-paginated={pages > 1 || undefined}>
      {tasks.slice(start, start + HOME_TASK_PAGE_SIZE).map(task => <li key={task.id}><HomeTaskRow task={task} ready={ready} onOpen={onOpen} /></li>)}
    </ul>
    {pages > 1 && <nav className="work-home__pagination" aria-label="最近任务分页">
      <span role="status" aria-live="polite">第 {current + 1} / {pages} 页</span>
      <button ref={previousRef} type="button" aria-label="上一页任务" disabled={current === 0} onClick={event => {
        if (event.detail === 0) keyboardDirection.current = 'previous'
        setPage(current - 1)
      }}><Icon name="chevron-left" size={14} />上一页</button>
      <button ref={nextRef} type="button" aria-label="下一页任务" disabled={current === pages - 1} onClick={event => {
        if (event.detail === 0) keyboardDirection.current = 'next'
        setPage(current + 1)
      }}>下一页<Icon name="chevron-right" size={14} /></button>
    </nav>}
  </>
}

function HomeTaskRow({ task, ready, onOpen }: { task: SessionTask; ready: boolean; onOpen: (id: string) => void }): JSX.Element {
  const detail = useHoverDetail({ enabled: true, label: '任务详情', content: <div className="work-home-task-detail">
    <strong>{task.title}</strong>
    <p>{task.workspacePath || '独立任务'}</p>
    <div><TaskStatus task={task} ready={ready} /><span>更新于 {fullDateFormatter.format(task.updatedAt)}</span></div>
  </div> })
  return <>
    <button {...detail.triggerProps} type="button" className="work-task-row" data-task-id={task.id}
      aria-label={`打开任务：${task.title}`} onClick={() => onOpen(task.id)}>
      <Icon name="chat" size={16} />
      <span className="work-task-row__name"><strong>{task.title}</strong><span>{task.workspacePath ? projectName(task.workspacePath) : '独立任务'}</span></span>
      <TaskStatus task={task} ready={ready} />
      <time dateTime={new Date(task.updatedAt).toISOString()}>{dateFormatter.format(task.updatedAt)}</time>
      <Icon name="chevron-right" size={14} />
    </button>
    {detail.tooltip}
  </>
}
