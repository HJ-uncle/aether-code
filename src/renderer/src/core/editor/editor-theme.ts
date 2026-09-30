/**
 * Monaco 主题：从设计令牌取色
 *
 * Monaco 不吃 CSS 级联，主题必须以具体色值注册。策略是「继承内置主题、
 * 只覆盖外壳色」：语法高亮沿用 VS Code Dark+/Light+ 的成熟配色（inherit: true），
 * 而画布、行号、光标、选区、悬浮组件等外壳颜色全部从 tokens.css 读出，
 * 保证编辑器与 IDE 外壳始终是同一套材质 —— 编辑器不再是一块"贴进来的黑砖"。
 *
 * 光标与选区吃 --accent，与「强调色作用于交互态」的全局决策一致；
 * 同名重复 defineTheme 会整体覆盖并对所有编辑器即时生效，因此切换外观时
 * 只需重新注册 + setTheme，不需要动任何编辑器实例。
 */
import { cssColor, currentAppearance, withAlpha } from '@renderer/core/theme/palette'
import { monaco } from './monaco-setup'

export const EDITOR_THEME_DARK = 'aether-dark'
export const EDITOR_THEME_LIGHT = 'aether-light'

/**
 * 深色语法着色规则（VS Code Dark+ / dark_plus 的 token 配色）。
 *
 * 必须显式列全，不能依赖 `base: 'vs-dark'` 的内置规则：
 * Monaco 0.56 的 standalone 内置主题（esm/vs/editor/standalone/common/themes.js）
 * 只剩 `''` / `invalid` 等极少数通用规则，0.55 时代那套 identifier / keyword /
 * string 配色已经不在包里（`9cdcfe` 这类色值在 0.56 全量搜索为 0 命中）。
 * 结果就是：一旦不自己给规则，几乎所有权标都落到 `editor.foreground` 上，
 * 代码变成整片同色的灰白 —— 这正是"代码发白"的原因。
 *
 * 两个额外要点：
 *   - `token: ''` 与 `token: 'invalid'` 都要给。Monaco 的 monarch 分词器把
 *     「没被任何规则匹配到的字符」一律标成 invalid，中文/日文正文会因此整片
 *     飘红；把 invalid 拉回正文色才能让非 ASCII 文本正常显示。
 *   - TextMate scope 那一段是给语义高亮用的，monarch 分词器不产出这些 token，
 *     但 TS/JS 的语言服务会。
 */
const DARK_TOKEN_RULES: { token: string; foreground: string }[] = [
  { token: '', foreground: 'd4d4d4' },
  { token: 'invalid', foreground: 'd4d4d4' },
  { token: 'identifier', foreground: '9cdcfe' },
  { token: 'type.identifier', foreground: '4ec9b0' },
  { token: 'number', foreground: 'b5cea8' },
  { token: 'delimiter', foreground: 'd4d4d4' },
  { token: 'delimiter.bracket', foreground: 'd4d4d4' },
  { token: 'delimiter.parenthesis', foreground: 'd4d4d4' },
  { token: 'delimiter.square', foreground: 'd4d4d4' },
  { token: 'delimiter.angle', foreground: 'd4d4d4' },
  { token: 'regexp', foreground: 'd16969' },
  { token: 'annotation', foreground: 'dcdcaa' },
  { token: 'tag', foreground: '569cd6' },
  { token: 'metatag', foreground: '569cd6' },
  { token: 'attribute.name', foreground: '9cdcfe' },
  { token: 'attribute.value', foreground: 'ce9178' },
  { token: 'string.key.json', foreground: '9cdcfe' },
  { token: 'string.value.json', foreground: 'ce9178' },
  { token: 'comment.doc', foreground: '6a9955' },
  { token: 'comment', foreground: '6a9955' },
  { token: 'comment.documentation', foreground: '7c7c7c' },
  { token: 'string', foreground: 'ce9178' },
  { token: 'string.escape', foreground: 'd7ba7d' },
  { token: 'constant.character.escape', foreground: 'd7ba7d' },
  { token: 'keyword', foreground: '569cd6' },
  { token: 'keyword.control', foreground: 'c586c0' },
  { token: 'keyword.operator', foreground: 'd4d4d4' },
  { token: 'keyword.operator.expression', foreground: '569cd6' },
  { token: 'entity.name.function', foreground: 'dcdcaa' },
  { token: 'support.function', foreground: 'dcdcaa' },
  { token: 'variable', foreground: '9cdcfe' },
  { token: 'variable.other', foreground: '9cdcfe' },
  { token: 'variable.parameter', foreground: '9cdcfe' },
  { token: 'variable.language', foreground: '569cd6' },
  { token: 'entity.name.type', foreground: '4ec9b0' },
  { token: 'entity.name.class', foreground: '4ec9b0' },
  { token: 'support.type', foreground: '4ec9b0' },
  { token: 'support.class', foreground: '4ec9b0' },
  { token: 'constant.numeric', foreground: 'b5cea8' },
  { token: 'constant.language', foreground: '569cd6' },
  { token: 'constant.language.boolean', foreground: '569cd6' },
  { token: 'constant.language.null', foreground: '569cd6' },
  { token: 'support.constant', foreground: 'b5cea8' },
  { token: 'punctuation', foreground: 'd4d4d4' },
  { token: 'punctuation.separator', foreground: 'd4d4d4' },
  { token: 'punctuation.terminator', foreground: 'd4d4d4' },
  { token: 'entity.name.tag', foreground: '569cd6' },
  { token: 'entity.other.attribute', foreground: '9cdcfe' },
  { token: 'storage', foreground: '569cd6' },
  { token: 'storage.type', foreground: '569cd6' },
  { token: 'storage.modifier', foreground: '569cd6' },
  { token: 'string.regexp', foreground: 'd16969' },
  { token: 'meta.decorator', foreground: 'dcdcaa' },
  { token: 'markup.heading', foreground: '569cd6' },
  { token: 'support.type.property-name', foreground: '9cdcfe' },
  { token: 'variable.other.property', foreground: '9cdcfe' },
  { token: 'support.type.property-name.json', foreground: '9cdcfe' }
]

/** 浅色语法着色规则（VS Code Light+ / light_plus 的 token 配色） */
const LIGHT_TOKEN_RULES: { token: string; foreground: string }[] = [
  { token: '', foreground: '000000' },
  { token: 'invalid', foreground: '000000' },
  { token: 'identifier', foreground: '001080' },
  { token: 'type.identifier', foreground: '267f99' },
  { token: 'number', foreground: '098658' },
  { token: 'delimiter', foreground: '000000' },
  { token: 'delimiter.bracket', foreground: '000000' },
  { token: 'delimiter.parenthesis', foreground: '000000' },
  { token: 'delimiter.square', foreground: '000000' },
  { token: 'delimiter.angle', foreground: '000000' },
  { token: 'regexp', foreground: '811f3f' },
  { token: 'annotation', foreground: '795e26' },
  { token: 'tag', foreground: '800000' },
  { token: 'metatag', foreground: '0000ff' },
  { token: 'attribute.name', foreground: 'e50000' },
  { token: 'attribute.value', foreground: '0451a5' },
  { token: 'string.key.json', foreground: '0451a5' },
  { token: 'string.value.json', foreground: 'a31515' },
  { token: 'comment.doc', foreground: '008000' },
  { token: 'comment', foreground: '008000' },
  { token: 'comment.documentation', foreground: '008000' },
  { token: 'string', foreground: 'a31515' },
  { token: 'string.escape', foreground: 'ce9178' },
  { token: 'constant.character.escape', foreground: 'ce9178' },
  { token: 'keyword', foreground: '0000ff' },
  { token: 'keyword.control', foreground: 'af00db' },
  { token: 'keyword.operator', foreground: '000000' },
  { token: 'entity.name.function', foreground: '795e26' },
  { token: 'support.function', foreground: '795e26' },
  { token: 'variable', foreground: '001080' },
  { token: 'variable.other', foreground: '001080' },
  { token: 'variable.parameter', foreground: '001080' },
  { token: 'variable.language', foreground: '0000ff' },
  { token: 'entity.name.type', foreground: '267f99' },
  { token: 'entity.name.class', foreground: '267f99' },
  { token: 'support.type', foreground: '267f99' },
  { token: 'support.class', foreground: '267f99' },
  { token: 'constant.numeric', foreground: '098658' },
  { token: 'constant.language', foreground: '0000ff' },
  { token: 'constant.language.boolean', foreground: '0000ff' },
  { token: 'constant.language.null', foreground: '0000ff' },
  { token: 'support.constant', foreground: '098658' },
  { token: 'punctuation', foreground: '000000' },
  { token: 'punctuation.separator', foreground: '000000' },
  { token: 'entity.name.tag', foreground: '800000' },
  { token: 'entity.other.attribute', foreground: 'ff0000' },
  { token: 'storage', foreground: '0000ff' },
  { token: 'storage.type', foreground: '0000ff' },
  { token: 'storage.modifier', foreground: '0000ff' },
  { token: 'string.regexp', foreground: '811f3f' },
  { token: 'meta.decorator', foreground: '795e26' },
  { token: 'markup.heading', foreground: '0000ff' },
  { token: 'support.type.property-name', foreground: '001080' },
  { token: 'variable.other.property', foreground: '001080' },
  { token: 'support.type.property-name.json', foreground: '001080' }
]

/** diff / patch 文件的语法着色（Monaco 0.56 不再内置 diff 语言，由 monaco-setup.ts 注册） */
const DIFF_RULES_DARK = [
  { token: 'markup.inserted.diff', foreground: 'b5cea8' },
  { token: 'markup.deleted.diff', foreground: 'ce9178' },
  { token: 'markup.changed.diff', foreground: '569cd6' },
  { token: 'meta.diff.header', foreground: '569cd6' }
]

const DIFF_RULES_LIGHT = [
  { token: 'markup.inserted.diff', foreground: '098658' },
  { token: 'markup.deleted.diff', foreground: 'a31515' },
  { token: 'markup.changed.diff', foreground: '0451a5' },
  { token: 'meta.diff.header', foreground: '000080' }
]

/** 当前外观对应的主题名（创建编辑器时的初始 theme 参数用） */
export function currentEditorThemeName(): string {
  return currentAppearance() === 'light' ? EDITOR_THEME_LIGHT : EDITOR_THEME_DARK
}

/** 按当前令牌构建主题数据。base 决定继承哪套语法高亮 */
function themeData(base: 'vs' | 'vs-dark', light: boolean): monaco.editor.IStandaloneThemeData {
  const accent = cssColor('--accent')
  // Monaco 画布与编辑器 Chrome 分层：代码区保持稳定的 VS Code 深色底，
  // 标签/建议框使用 Chrome 令牌，避免透明材质让语法文字透出产生噪点。
  const canvas = cssColor('--editor-canvas')
  const chrome = cssColor('--editor-chrome')
  const chromeBorder = cssColor('--editor-border')
  const warn = cssColor('--warn')

  return {
    base,
    inherit: true,
    // 语法着色 + diff 着色：全套自己给（0.56 内置主题已不含 token 配色），
    // 详见上方 DARK_TOKEN_RULES 的说明。
    rules: light ? [...LIGHT_TOKEN_RULES, ...DIFF_RULES_LIGHT] : [...DARK_TOKEN_RULES, ...DIFF_RULES_DARK],
    colors: {
      // 画布与外壳同材质：折叠区、行号槽、小地图连成一片
      'editor.background': canvas,
      'editor.foreground': cssColor('--fg'),
      'editorGutter.background': canvas,
      'minimap.background': canvas,
      'editorLineNumber.foreground': cssColor('--fg-faint'),
      'editorLineNumber.activeForeground': cssColor('--fg-muted'),
      'editorWhitespace.foreground': cssColor('--border-strong'),
      'editorRuler.foreground': cssColor('--border'),
      'editorIndentGuide.background': cssColor('--border'),
      'editorIndentGuide.background1': cssColor('--border'),
      'editorIndentGuide.activeBackground': cssColor('--border-strong'),
      'editorIndentGuide.activeBackground1': cssColor('--border-strong'),

      // 光标与选区：强调色交互态
      'editorCursor.foreground': accent,
      'editor.selectionBackground': withAlpha(accent, light ? '3d' : '4d'),
      'editor.inactiveSelectionBackground': withAlpha(accent, light ? '1f' : '29'),
      'editor.selectionHighlightBackground': cssColor('--accent-soft'),
      'editor.wordHighlightBackground': cssColor('--accent-soft'),

      // 当前行：外壳 hover 同款低对比底
      'editor.lineHighlightBackground': cssColor('--bg-hover'),
      'editor.lineHighlightBorder': '#00000000',

      // 括号匹配：强调色软底
      'editorBracketMatch.background': cssColor('--accent-soft'),
      'editorBracketMatch.border': withAlpha(accent, '66'),

      // 查找高亮：warn 黄，与搜索面板的命中标记同语义
      'editor.findMatchBackground': withAlpha(warn, light ? '40' : '59'),
      'editor.findMatchBorder': withAlpha(warn, '80'),
      'editor.findMatchHighlightBackground': withAlpha(warn, light ? '2b' : '3d'),
      'editor.findMatchHighlightBorder': '#00000000',
      'editor.findRangeHighlightBackground': cssColor('--bg-hover'),
      'editorOverviewRuler.findMatchForeground': withAlpha(warn, '99'),

      // 诊断色：语义令牌。错误背景强制透明——VS Code 现代主题只画波浪线，
      // 不把整行/整词染成红底（避免 .patch 等被 linter 误判时满屏红块）。
      'editorError.background': '#00000000',
      'editorError.foreground': cssColor('--danger'),
      'editorWarning.background': '#00000000',
      'editorWarning.foreground': cssColor('--warn'),
      'editorInfo.background': '#00000000',
      'editorInfo.foreground': cssColor('--ok'),
      'editorGhostText.foreground': cssColor('--fg-faint'),
      'editorCodeLens.foreground': cssColor('--fg-faint'),

      // 悬浮组件（建议 / 悬停 / 查找框）：磨砂材质同款
      'editorWidget.background': chrome,
      'editorWidget.border': chromeBorder,
      // --material-shadow 是 box-shadow 串不是颜色，widget.shadow 只要颜色；
      // 阴影两套外观都是黑，直接用黑色 alpha（给纯色会变"红色阴影"）
      'widget.shadow': withAlpha('#000000', '59'),
      'editorSuggestWidget.background': chrome,
      'editorSuggestWidget.border': chromeBorder,
      'editorSuggestWidget.foreground': cssColor('--fg'),
      'editorSuggestWidget.selectedBackground': cssColor('--bg-active'),
      'editorSuggestWidget.selectedIconForeground': accent,
      'editorHoverWidget.background': chrome,
      'editorHoverWidget.border': chromeBorder,

      // 组件内表单与列表
      'input.background': cssColor('--bg-input'),
      'input.foreground': cssColor('--fg'),
      'input.border': cssColor('--border-strong'),
      'inputOption.activeBorder': accent,
      'inputOption.activeBackground': cssColor('--accent-soft'),
      focusBorder: accent,
      'list.hoverBackground': cssColor('--bg-hover'),
      'list.activeSelectionBackground': cssColor('--accent-soft'),
      'list.activeSelectionForeground': cssColor('--fg-strong'),
      'list.focusBackground': cssColor('--bg-active'),
      'list.inactiveSelectionBackground': cssColor('--bg-hover'),

      // 链接与滚动条
      'editorLink.activeForeground': accent,
      'scrollbarSlider.background': cssColor('--scrollbar-thumb'),
      'scrollbarSlider.hoverBackground': cssColor('--scrollbar-thumb-hover'),
      'scrollbarSlider.activeBackground': cssColor('--scrollbar-thumb-hover')
    }
  }
}

/**
 * 按当前 <html> 令牌注册并切换主题。
 * 挂载时调用一次；之后由 watchTheme 在外观/强调色变化时重新调用。
 */
export function refreshEditorTheme(): void {
  const light = currentAppearance() === 'light'
  monaco.editor.defineTheme(
    light ? EDITOR_THEME_LIGHT : EDITOR_THEME_DARK,
    themeData(light ? 'vs' : 'vs-dark', light)
  )
  monaco.editor.setTheme(currentEditorThemeName())
}
