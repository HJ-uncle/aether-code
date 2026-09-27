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

/** 当前外观对应的主题名（创建编辑器时的初始 theme 参数用） */
export function currentEditorThemeName(): string {
  return currentAppearance() === 'light' ? EDITOR_THEME_LIGHT : EDITOR_THEME_DARK
}

/** 按当前令牌构建主题数据。base 决定继承哪套语法高亮 */
function themeData(base: 'vs' | 'vs-dark', light: boolean): monaco.editor.IStandaloneThemeData {
  const accent = cssColor('--accent')
  // 编辑器容器与激活标签都是 --bg-app：画布用同色才能连成一片（VS Code 的激活标签观感）
  const canvas = cssColor('--bg-app')
  const material = cssColor('--material-bg')
  const materialBorder = cssColor('--material-border')
  const warn = cssColor('--warn')

  return {
    base,
    inherit: true,
    // diff / patch 文件的语法着色：照搬 VS Code Dark+/Light+ 默认 token 配色。
    // Monaco 0.56 不再内置 diff 语言，由 monaco-setup.ts 注册（token 名沿用
    // VS Code TextMate scope：markup.inserted.diff / markup.deleted.diff / meta.diff.header）。
    // 注意只设 foreground，不加背景——VS Code 看 diff 文件就是纯色文字，不是红底条带。
    rules: light
      ? [
          { token: 'markup.inserted.diff', foreground: '098658' },
          { token: 'markup.deleted.diff', foreground: 'a31515' },
          { token: 'markup.changed.diff', foreground: '0451a5' },
          { token: 'meta.diff.header', foreground: '000080' }
        ]
      : [
          { token: 'markup.inserted.diff', foreground: 'b5cea8' },
          { token: 'markup.deleted.diff', foreground: 'ce9178' },
          { token: 'markup.changed.diff', foreground: '569cd6' },
          { token: 'meta.diff.header', foreground: '569cd6' }
        ],
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
      'editorWidget.background': material,
      'editorWidget.border': materialBorder,
      // --material-shadow 是 box-shadow 串不是颜色，widget.shadow 只要颜色；
      // 阴影两套外观都是黑，直接用黑色 alpha（给纯色会变"红色阴影"）
      'widget.shadow': withAlpha('#000000', '59'),
      'editorSuggestWidget.background': material,
      'editorSuggestWidget.border': materialBorder,
      'editorSuggestWidget.foreground': cssColor('--fg'),
      'editorSuggestWidget.selectedBackground': cssColor('--bg-active'),
      'editorSuggestWidget.selectedIconForeground': accent,
      'editorHoverWidget.background': material,
      'editorHoverWidget.border': materialBorder,

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
