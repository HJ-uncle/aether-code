import { registerCommands } from '@renderer/core/platform/commands'
import { registerKeybindings } from '@renderer/core/platform/keybindings'
import { openViewToRight } from '@renderer/core/editor/editor-groups'
import { registerView } from '@renderer/workbench/view-registry'
import { registerSettings } from '../settings/settings-registry'
import { openAppSettings } from '../settings/app-settings-navigation'
import { BrowserView } from './BrowserView'
import { browserAction, disposeBrowser, initializeBrowser, openBrowser } from './browser-store'

export { openBrowser } from './browser-store'

export function registerBrowserContribution(): () => void {
  const view = registerView({
    id: 'browser',
    title: '浏览器',
    location: 'editor',
    icon: 'eye-outline',
    order: 20,
    closable: true,
    component: BrowserView
  })
  const commands = registerCommands([
    {
      id: 'aether.browser.open',
      title: '打开内置浏览器',
      category: '浏览器',
      run: () => openBrowser()
    },
    {
      id: 'aether.browser.openToSide',
      title: '在右侧打开浏览器',
      category: '浏览器',
      run: async () => {
        openViewToRight('browser')
        await openBrowser()
      }
    },
    {
      id: 'aether.browser.settings',
      title: '打开浏览器设置',
      category: '浏览器',
      run: () => openAppSettings('browser')
    },
    {
      id: 'aether.browser.newTab',
      title: '新建网页标签',
      category: '浏览器',
      run: () => {
        browserAction(async () => {
          await initializeBrowser()
          await window.aether.browser.create({})
        })
      }
    }
  ])
  const keys = registerKeybindings([{ key: 'ctrl+alt+b', command: 'aether.browser.openToSide' }])
  const settings = registerSettings([
    {
      key: 'browser.homeUrl',
      label: '浏览器默认地址',
      description: '新建网页标签的默认地址，可填写项目开发服务地址。',
      section: 'browser',
      category: '功能 / 浏览器',
      scope: 'user',
      keywords: ['browser', '网页', '网址', 'localhost', '浏览器']
    },
    {
      key: 'browser.zoomFactor',
      label: '默认网页缩放',
      description: '设置新建网页的显示缩放比例。',
      section: 'browser',
      category: '功能 / 浏览器',
      scope: 'user',
      keywords: ['browser', 'zoom', '网页', '缩放']
    },
    {
      key: 'browser.defaultViewport',
      label: '默认浏览器视口',
      description: '选择桌面、手机或自适应网页视口。',
      section: 'browser',
      category: '功能 / 浏览器',
      scope: 'user',
      keywords: ['browser', 'viewport', '手机', '桌面', '响应式']
    },
    {
      key: 'browser.persistSession',
      label: '保存网页登录状态',
      description: '保留浏览器的 Cookie、登录和站点存储。',
      section: 'browser',
      category: '功能 / 浏览器',
      scope: 'user',
      keywords: ['cookie', '登录', '会话', '缓存']
    },
    {
      key: 'browser.aiEnabled',
      label: '允许 AI 使用内置浏览器',
      description: '让当前对话的 AI 读取与操作内置网页。',
      section: 'browser',
      category: '功能 / 浏览器',
      scope: 'user',
      keywords: ['ai', '测试', 'browser', '浏览器']
    }
  ])
  void initializeBrowser()
  return () => {
    view()
    commands()
    keys()
    settings()
    disposeBrowser()
  }
}
