import type { IPosition, IRange, languages } from 'monaco-editor'

export function documentSymbolKey(symbol: languages.DocumentSymbol): string {
  return `${symbol.kind}:${symbol.name}:${symbol.selectionRange.startLineNumber}:${symbol.selectionRange.startColumn}`
}

function contains(range: IRange, position: IPosition): boolean {
  return (
    (position.lineNumber > range.startLineNumber ||
      (position.lineNumber === range.startLineNumber && position.column >= range.startColumn)) &&
    (position.lineNumber < range.endLineNumber ||
      (position.lineNumber === range.endLineNumber && position.column <= range.endColumn))
  )
}

/** Keep ancestor symbols so an outline filter never loses the meaning of a nested match. */
export function filterDocumentSymbols(
  symbols: languages.DocumentSymbol[],
  query: string
): languages.DocumentSymbol[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return symbols
  return symbols.flatMap((symbol) => {
    if (symbol.name.toLocaleLowerCase().includes(needle)) return [symbol]
    const children = filterDocumentSymbols(symbol.children ?? [], needle)
    return children.length ? [{ ...symbol, children }] : []
  })
}

/** Used by the outline selection and the breadcrumb chain without another LSP round trip. */
export function findDocumentSymbolPath(
  symbols: languages.DocumentSymbol[],
  position: IPosition
): languages.DocumentSymbol[] {
  for (const symbol of symbols) {
    if (contains(symbol.range, position))
      return [symbol, ...findDocumentSymbolPath(symbol.children ?? [], position)]
  }
  return []
}

const KIND_LABELS = [
  '文件',
  '模块',
  '命名空间',
  '包',
  '类',
  '方法',
  '属性',
  '字段',
  '构造函数',
  '枚举',
  '接口',
  '函数',
  '变量',
  '常量',
  '字符串',
  '数字',
  '布尔值',
  '数组',
  '对象',
  '键',
  '空值',
  '枚举项',
  '结构',
  '事件',
  '运算符',
  '类型参数'
]
export function documentSymbolKindLabel(kind: languages.SymbolKind): string {
  return KIND_LABELS[kind] ?? '符号'
}
