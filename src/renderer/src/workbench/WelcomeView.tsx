import { useSyncExternalStore, type JSX } from 'react'
import { executeCommand } from '@renderer/core/platform/commands'
import { getKeybindingHint } from '@renderer/core/platform/keybindings'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { openFolderAt } from '@renderer/core/workspace/workspace-store'
import {
  forgetRecentFolder,
  getRecentFolders,
  onRecentFoldersChanged
} from '@renderer/core/workspace/recent-folders'
import { Icon, type IconName } from '@renderer/workbench/icons'

/**
 * 欢迎页（对标 VS Code 的 Welcome / Get Started）
 *
 * 主区没有任何打开的标签时显示，是产品给用户的第一印象：
 *   - 左侧：开始（打开文件夹 / 新建会话）、最近、小技巧
 *   - 右侧：常用快捷键速查
 * 所有条目都只是「命令 ID + 键位提示」，动作与菜单/命令面板同源，
 * 不在这里写任何实现 —— 后续新增小技巧只需往 TIPS 里加一条。
 */

interface StartAction {
  label: string
  description: string
  command: string
  icon: IconName
}

const START_ACTIONS: StartAction[] = [
  {
    label: '打开文件夹',
    description: '选择本地项目目录，Agent 将在其中工作',
    command: 'aether.workspace.openFolder',
    icon: 'explorer'
  },
  {
    label: '新建会话',
    description: '与 Agent 开始一段新对话',
    command: 'aether.chat.newSession',
    icon: 'chat'
  },
  {
    label: '全局搜索',
    description: '在项目中按内容查找',
    command: 'aether.view.search',
    icon: 'search'
  },
  {
    label: '打开设置',
    description: '引擎 / 模型 / 安全 / 代码图索引',
    command: 'aether.view.appSettings',
    icon: 'settings'
  }
]

interface Tip {
  title: string
  body: string
}

/** 小技巧：后续可持续补充（产品化「首页放小技巧」的落点） */
const TIPS: Tip[] = [
  {
    title: '让 Agent 先建代码图索引',
    body: '对话页脚的「建索引」会为当前项目构建符号/调用关系图谱，之后问「X 被谁调用」这类问题会准确得多。'
  },
  {
    title: '把需求说清楚再动手',
    body: '描述问题时带上文件路径、期望行为和你已经试过的做法，比一句「这个不行」能省下好几轮来回。'
  },
  {
    title: '安全模式按需切换',
    body: '默认会为敏感操作征求你的同意；确认可信时切到「一路放行」，避免每一步都被打断。'
  }
]

const SHORTCUTS: Array<{ label: string; command: string; fallback: string }> = [
  { label: '显示所有命令', command: 'aether.commandPalette.toggle', fallback: 'Ctrl+Shift+P' },
  { label: '转到文件', command: 'aether.quickOpen.toggle', fallback: 'Ctrl+P' },
  { label: '打开对话', command: 'aether.view.chat', fallback: 'Ctrl+Shift+C' },
  { label: '全局搜索', command: 'aether.view.search', fallback: 'Ctrl+Shift+F' },
  { label: '打开设置', command: 'aether.view.appSettings', fallback: 'Ctrl+,' },
  { label: '切换终端', command: 'aether.panel.terminal', fallback: 'Ctrl+`' }
]

/** 快捷键提示：优先展示用户自定义键位，未绑定时退回内置默认值 */
function hintOf(command: string, fallback: string): string {
  return (getKeybindingHint(command) || fallback).replace(/\+/g, ' + ')
}

export function WelcomeView(): JSX.Element {
  const workspace = useWorkspace()
  const recentFolders = useSyncExternalStore(onRecentFoldersChanged, getRecentFolders)
  /** 当前已打开的项目不再列入「最近打开」——它就在上面写着，重复列只会占位 */
  const recent = recentFolders.filter((folder) => folder !== workspace.root)

  const openRecent = (folder: string): void => {
    void openFolderAt(folder).catch(() => {
      // 目录已被删除/无权限：从历史里摘掉，避免用户反复点到一个打不开的项
      forgetRecentFolder(folder)
    })
  }

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <header className="welcome__header">
          <h1 className="welcome__title">Aether IDE</h1>
          {workspace.root ? (
            <p className="welcome__subtitle" title={workspace.root}>
              当前项目：{workspace.root.replace(/\\/g, '/').split('/').pop()}
            </p>
          ) : (
            <p className="welcome__subtitle">打开一个文件夹开始，或直接与 Agent 对话</p>
          )}
        </header>

        <div className="welcome__columns">
          <section className="welcome__col">
            <h2 className="welcome__section">开始</h2>
            <ul className="welcome__list">
              {START_ACTIONS.map((action) => (
                <li key={action.command}>
                  <button
                    type="button"
                    className="welcome__action"
                    onClick={() => void executeCommand(action.command)}
                  >
                    <span className="welcome__action-icon">
                      <Icon name={action.icon} size={16} />
                    </span>
                    <span className="welcome__action-text">
                      <span className="welcome__action-label">{action.label}</span>
                      <span className="welcome__action-desc">{action.description}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {recent.length > 0 ? (
              <>
                <h2 className="welcome__section">最近打开</h2>
                <ul className="welcome__list welcome__list--recent">
                  {recent.map((folder) => {
                    const name = folder.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? folder
                    // 未打开任何项目时才把「移除」暴露出来：已有项目在跑时误删历史更碍事
                    const removable = !workspace.root
                    return (
                      <li key={folder} className="welcome__recent">
                        <button
                          type="button"
                          className="welcome__recent-open"
                          title={folder}
                          onClick={() => openRecent(folder)}
                        >
                          <Icon name="explorer" size={14} />
                          <span className="welcome__recent-text">
                            <span className="welcome__recent-name">{name}</span>
                            <span className="welcome__recent-path">{folder}</span>
                          </span>
                        </button>
                        {removable ? (
                          <button
                            type="button"
                            className="welcome__recent-remove"
                            title="从列表中移除"
                            aria-label={`从列表中移除 ${name}`}
                            onClick={() => forgetRecentFolder(folder)}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </>
            ) : null}

            <h2 className="welcome__section">小技巧</h2>
            <ul className="welcome__list">
              {TIPS.map((tip) => (
                <li key={tip.title} className="welcome__tip">
                  <span className="welcome__tip-title">{tip.title}</span>
                  <span className="welcome__tip-body">{tip.body}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="welcome__col">
            <h2 className="welcome__section">常用快捷键</h2>
            <ul className="welcome__list welcome__list--keys">
              {SHORTCUTS.map((item) => (
                <li key={item.command} className="welcome__key-row">
                  <button
                    type="button"
                    className="welcome__key-label"
                    title={`执行：${item.label}`}
                    onClick={() => void executeCommand(item.command)}
                  >
                    {item.label}
                  </button>
                  <kbd className="welcome__key">{hintOf(item.command, item.fallback)}</kbd>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="welcome__link"
              onClick={() => void executeCommand('aether.preferences.openKeybindings')}
            >
              查看全部键盘快捷方式
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
