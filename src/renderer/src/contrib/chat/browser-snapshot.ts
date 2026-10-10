import type { BrowserElement, BrowserSnapshot } from '@shared/browser'
import { viewportScreenshot } from './tool-image'

export interface ToolBrowserSnapshot {
  title: string
  url: string
  text: string
  elements: BrowserElement[]
  loading?: boolean
  viewport?: { width: number; height: number }
  screenshot?: BrowserSnapshot['screenshot']
  snapshotUnavailable?: string
  interaction?: BrowserSnapshot['interaction']
  truncated: boolean
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  rootwebarea: '页面', webarea: '页面区域', document: '文档', application: '应用',
  statictext: '文本', inlinetextbox: '行内文本', text: '文本', labeltext: '标签', generic: '容器', none: '无语义元素',
  textbox: '输入框', textfield: '输入框', searchbox: '搜索框', button: '按钮', togglebutton: '切换按钮',
  link: '链接', heading: '标题', image: '图片', img: '图片', imagebutton: '图片按钮',
  checkbox: '复选框', radio: '单选按钮', radiogroup: '单选组', switch: '开关',
  combobox: '组合框', listbox: '选项列表', option: '选项', listboxoption: '选项',
  menu: '菜单', menubar: '菜单栏', menuitem: '菜单项', menuitemcheckbox: '复选菜单项', menuitemradio: '单选菜单项',
  tab: '标签页', tablist: '标签栏', tabpanel: '标签面板', tree: '树形列表', treeitem: '树形条目', treegrid: '树形表格',
  grid: '网格', gridcell: '网格单元格', row: '行', rowgroup: '行组', cell: '单元格',
  table: '表格', columnheader: '列标题', rowheader: '行标题', caption: '说明',
  layouttable: '布局表格', layouttablerow: '布局行', layouttablecell: '布局单元格',
  scrollbar: '滚动条', slider: '滑块', spinbutton: '数值输入框', progressbar: '进度条', meter: '计量条',
  separator: '分隔线', splitter: '分隔条', toolbar: '工具栏', tooltip: '提示',
  alert: '警告', alertdialog: '警告对话框', dialog: '对话框', status: '状态', log: '日志', marquee: '滚动信息', timer: '计时器',
  form: '表单', search: '搜索区域', navigation: '导航', main: '主要内容', contentinfo: '页脚信息',
  banner: '页眉', complementary: '辅助内容', region: '区域', article: '文章', section: '章节',
  sectionheader: '章节标题', sectionfooter: '章节页脚', group: '分组', list: '列表', listitem: '列表项', listmarker: '列表标记',
  definition: '定义', term: '术语', descriptionlist: '描述列表', descriptionlistdetail: '描述内容', descriptionlistterm: '描述名称',
  canvas: '画布', figure: '图表', figcaption: '图表说明', footer: '页脚', header: '页眉',
  paragraph: '段落', blockquote: '引用', code: '代码', emphasis: '强调', strong: '加粗文本', mark: '标记文本',
  math: '公式', time: '时间', date: '日期', datetime: '日期时间', inputtime: '时间输入框',
  audio: '音频', video: '视频', embeddedobject: '嵌入内容', iframe: '内嵌页面',
  details: '详细信息', disclosuretriangle: '展开按钮', colorwell: '颜色选择器',
  linebreak: '换行', ruby: '注音', rubyannotation: '注音说明',
  insertion: '插入内容', deletion: '删除内容', subscript: '下标', superscript: '上标',
  directory: '目录', feed: '信息流', note: '注释', presentation: '展示元素'
}

/** AX role casing differs between Chromium versions; unknown extension roles remain identifiable. */
export function browserElementRoleLabel(role: string): string {
  const key = role.toLowerCase()
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, key) ? ROLE_LABELS[key] : role
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// This bounds untrusted display geometry, not browser tool execution. Finite doubles can still
// overflow coordinate formatting or SVG's numeric representation when restored from history.
const MAX_DRAW_COORDINATE = 2 ** 31 - 1

function drawableCoordinate(value: unknown): value is number {
  return finiteNumber(value) && Math.abs(value) <= MAX_DRAW_COORDINATE
}

function drawableViewportDimension(value: unknown): value is number {
  return drawableCoordinate(value) && Number.isInteger(value) && value >= 1
}

/** Missing geometry is old history; null records a completed lookup with no layout box. */
function parseElementBounds(value: unknown): BrowserElement['bounds'] {
  if (value === null) return null
  const bounds = record(value)
  if (!bounds || !drawableCoordinate(bounds.x) || !drawableCoordinate(bounds.y) ||
      !drawableCoordinate(bounds.width) || bounds.width < 0 ||
      !drawableCoordinate(bounds.height) || bounds.height < 0) return undefined
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
}

/** Click coordinates belong to the viewport before the click, which may navigate to a new page. */
function parseClickInteraction(value: unknown): BrowserSnapshot['interaction'] | undefined {
  const source = record(value)
  const viewport = record(source?.viewport)
  if (!source || source.type !== 'click' || !viewport ||
      !drawableViewportDimension(viewport.width) || !drawableViewportDimension(viewport.height) ||
      !finiteNumber(viewport.deviceScaleFactor) || viewport.deviceScaleFactor <= 0 ||
      !finiteNumber(viewport.scrollX) || !finiteNumber(viewport.scrollY) ||
      !finiteNumber(source.x) || source.x < 0 || source.x >= viewport.width ||
      !finiteNumber(source.y) || source.y < 0 || source.y >= viewport.height ||
      !finiteNumber(source.navigationId) || !Number.isSafeInteger(source.navigationId) || source.navigationId < 0 ||
      typeof source.pageUrl !== 'string' || !source.pageUrl.trim()) return undefined

  let target: NonNullable<BrowserSnapshot['interaction']>['target']
  if (source.target !== undefined) {
    const candidate = record(source.target)
    if (!candidate) return undefined
    for (const key of ['name', 'role', 'ref', 'selector'] as const) {
      if (candidate[key] !== undefined && typeof candidate[key] !== 'string') return undefined
    }
    target = {
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
      ...(typeof candidate.role === 'string' ? { role: candidate.role } : {}),
      ...(typeof candidate.ref === 'string' ? { ref: candidate.ref } : {}),
      ...(typeof candidate.selector === 'string' ? { selector: candidate.selector } : {})
    }
    if (candidate.bounds !== undefined) {
      const bounds = record(candidate.bounds)
      if (!bounds || !drawableCoordinate(bounds.x) || !drawableCoordinate(bounds.y) ||
          !drawableCoordinate(bounds.width) || bounds.width <= 0 ||
          !drawableCoordinate(bounds.height) || bounds.height <= 0) return undefined
      target.bounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    }
  }

  const screenshot = viewportScreenshot(source.screenshot)
  return {
    type: 'click', x: source.x, y: source.y,
    navigationId: source.navigationId, pageUrl: source.pageUrl,
    viewport: {
      width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor,
      scrollX: viewport.scrollX, scrollY: viewport.scrollY
    },
    ...(target ? { target } : {}),
    ...(screenshot ? { screenshot } : {})
  }
}

/** Snapshot text, element names and URLs remain opaque display data, never HTML or navigation actions. */
export function parseBrowserSnapshot(value: unknown): ToolBrowserSnapshot | null {
  const source = record(value)
  const tab = record(source?.tab)
  if (!source || !tab || typeof tab.url !== 'string' || !tab.url.trim() || typeof tab.title !== 'string' ||
      typeof source.text !== 'string' || !Array.isArray(source.elements)) return null
  if (source.truncated !== undefined && typeof source.truncated !== 'boolean') return null
  if (tab.loading !== undefined && typeof tab.loading !== 'boolean') return null

  const elements: ToolBrowserSnapshot['elements'] = []
  for (const candidate of source.elements) {
    const element = record(candidate)
    if (!element || typeof element.role !== 'string' || !element.role.trim() || typeof element.name !== 'string' ||
        (element.value !== undefined && typeof element.value !== 'string') ||
        (element.ref !== undefined && typeof element.ref !== 'string')) return null
    const bounds = parseElementBounds(element.bounds)
    elements.push({
      role: element.role,
      name: element.name,
      ...(element.value !== undefined ? { value: element.value as string } : {}),
      ...(element.ref !== undefined ? { ref: element.ref as string } : {}),
      ...(bounds !== undefined ? { bounds } : {})
    })
  }

  let viewport: ToolBrowserSnapshot['viewport']
  if (source.viewport !== undefined) {
    const bounds = record(source.viewport)
    if (!bounds || typeof bounds.width !== 'number' || !Number.isFinite(bounds.width) || bounds.width <= 0 ||
        typeof bounds.height !== 'number' || !Number.isFinite(bounds.height) || bounds.height <= 0) return null
    viewport = { width: bounds.width, height: bounds.height }
  }
  const interaction = parseClickInteraction(source.interaction)
  const screenshot = viewportScreenshot(source.screenshot)

  return {
    title: tab.title,
    url: tab.url,
    text: source.text,
    elements,
    ...(typeof tab.loading === 'boolean' ? { loading: tab.loading } : {}),
    ...(viewport ? { viewport } : {}),
    ...(interaction ? { interaction } : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(typeof source.snapshotUnavailable === 'string' ? { snapshotUnavailable: source.snapshotUnavailable.slice(0, 1000) } : {}),
    truncated: source.truncated === true
  }
}
