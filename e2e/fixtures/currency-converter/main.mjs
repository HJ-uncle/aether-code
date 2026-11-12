// 货币换算器插件入口（apiVersion 1 / Node ESM）。
// 协议：stdin 写入一个 UTF-8 JSON {tool,args} 后关闭；成功时 stdout 输出一行 {result} JSON。
// 不访问网络：内置数值仅用于演示；实际换算请提供 rate / rates。

const SNAPSHOT_NOTE = '内置汇率仅为演示数值，无可验证的数据来源和日期，非实时行情；实际换算请指定 rate 或完整的 rates（1 USD 可兑换数量）。'
const MAX_AMOUNT = 1e15
const MIN_RATE = 1e-12
const MAX_RATE = 1e12

const CURRENCIES = {
  USD: { name: '美元', decimals: 2, perUsd: 1 },
  CNY: { name: '人民币', decimals: 2, perUsd: 7.1 },
  EUR: { name: '欧元', decimals: 2, perUsd: 0.92 },
  GBP: { name: '英镑', decimals: 2, perUsd: 0.78 },
  JPY: { name: '日元', decimals: 0, perUsd: 152 },
  HKD: { name: '港币', decimals: 2, perUsd: 7.8 },
  KRW: { name: '韩元', decimals: 0, perUsd: 1370 },
  TWD: { name: '新台币', decimals: 2, perUsd: 32.3 },
  SGD: { name: '新加坡元', decimals: 2, perUsd: 1.34 },
  AUD: { name: '澳大利亚元', decimals: 2, perUsd: 1.52 },
  CAD: { name: '加拿大元', decimals: 2, perUsd: 1.37 },
  CHF: { name: '瑞士法郎', decimals: 2, perUsd: 0.88 },
  INR: { name: '印度卢比', decimals: 2, perUsd: 84 },
  RUB: { name: '俄罗斯卢布', decimals: 2, perUsd: 92 },
  BRL: { name: '巴西雷亚尔', decimals: 2, perUsd: 5.6 },
  THB: { name: '泰铢', decimals: 2, perUsd: 34.5 },
  MYR: { name: '马来西亚林吉特', decimals: 2, perUsd: 4.45 },
  IDR: { name: '印度尼西亚盾', decimals: 0, perUsd: 15800 },
  PHP: { name: '菲律宾比索', decimals: 2, perUsd: 57.5 },
  VND: { name: '越南盾', decimals: 0, perUsd: 25400 },
  NZD: { name: '新西兰元', decimals: 2, perUsd: 1.66 },
  SEK: { name: '瑞典克朗', decimals: 2, perUsd: 10.6 },
  NOK: { name: '挪威克朗', decimals: 2, perUsd: 10.8 },
  DKK: { name: '丹麦克朗', decimals: 2, perUsd: 6.85 },
  PLN: { name: '波兰兹罗提', decimals: 2, perUsd: 3.95 },
  CZK: { name: '捷克克朗', decimals: 2, perUsd: 23.2 },
  HUF: { name: '匈牙利福林', decimals: 2, perUsd: 355 },
  TRY: { name: '土耳其里拉', decimals: 2, perUsd: 34.5 },
  ZAR: { name: '南非兰特', decimals: 2, perUsd: 18 },
  AED: { name: '阿联酋迪拉姆', decimals: 2, perUsd: 3.6725 },
  SAR: { name: '沙特里亚尔', decimals: 2, perUsd: 3.75 },
  MXN: { name: '墨西哥比索', decimals: 2, perUsd: 19.5 },
  EGP: { name: '埃及镑', decimals: 2, perUsd: 48.5 },
  ILS: { name: '以色列谢克尔', decimals: 2, perUsd: 3.72 },
}

// 使用输入数字的十进制表示和整数分数计算，先精确乘除，再按目标币种 half-up。
// 不先执行 amount * rate，避免 1.005 * 3 的浮点尾差把 3.015 错舍为 3.01。
function decimal(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('需要有限非负数字')
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e')
  const [integer, fraction = ''] = mantissa.split('.')
  const digits = BigInt(integer + fraction)
  const scale = fraction.length - Number(exponent)
  return scale >= 0 ? { n: digits, d: 10n ** BigInt(scale) } : { n: digits * 10n ** BigInt(-scale), d: 1n }
}
function quantize(n, d, places) {
  const scaled = n * (10n ** BigInt(places)), minor = scaled / d
  return minor + (scaled % d * 2n >= d ? 1n : 0n)
}
function minorText(minor, places) {
  const digits = String(minor).padStart(places + 1, '0')
  return places === 0 ? digits : digits.slice(0, -places) + '.' + digits.slice(-places)
}
function roundHalfUp(value, decimals) {
  const rational = decimal(value)
  return Number(minorText(quantize(rational.n, rational.d, decimals), decimals))
}
function preciseConversion(amount, numerator, denominator, places) {
  const a = decimal(amount), n = decimal(numerator), d = decimal(denominator)
  const minor = quantize(a.n * n.n * d.d, a.d * n.d * d.n, places)
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('换算结果过大，超出目标币种最小单位的安全精度，请减小金额或汇率')
  const result = Number(minorText(minor, places)), back = decimal(result)
  if (back.n * 10n ** BigInt(places) !== minor * back.d) throw new Error('换算结果无法以数字安全表示，请减小金额或汇率')
  return result
}
function displayRate(numerator, denominator = 1) {
  const n = decimal(numerator), d = decimal(denominator)
  const rounded = Number(minorText(quantize(n.n * d.d, n.d * d.n, 8), 8))
  return rounded === 0 ? numerator / denominator : rounded
}
function expressionSign(amount, rateText, result) {
  const a = decimal(amount), r = decimal(Number(rateText)), out = decimal(result)
  return a.n * r.n * out.d === out.n * a.d * r.d ? '=' : '≈'
}

function formatNumber(value, decimals) {
  const fixed = Math.abs(value).toFixed(decimals)
  const [integer, fraction] = fixed.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (value < 0 ? '-' : '') + grouped + (fraction ? '.' + fraction : '')
}

// 展示用：最多保留 maxDecimals 位并去掉末尾 0；数值字段仍以数字返回。
function trimNumber(value, maxDecimals = 6) {
  const rounded = roundHalfUp(value, maxDecimals)
  if (value > 0 && rounded === 0) return String(value)
  let text = rounded.toFixed(maxDecimals)
  if (/[eE]/.test(text)) return text
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text === '' || text === '-0' ? '0' : text
}

function formatAmount(value) {
  const text = String(value)
  if (/[eE]/.test(text)) return text
  const [integer, fraction] = text.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

function normalizeCode(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('货币代码必须是非空字符串，例如 USD、CNY')
  }
  const code = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('货币代码必须是 3 个字母，例如 USD、CNY；收到：' + value)
  return code
}

function resolveCurrency(value, label) {
  const code = normalizeCode(value)
  if (!Object.hasOwn(CURRENCIES, code)) {
    throw new Error(`${label} 不支持该货币：${code}；可调用 list_currencies 查看支持的货币`)
  }
  return code
}

function parseAmount(value, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new Error('缺少 amount（换算金额）')
    return fallback
  }
  const amount = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('amount 必须是有限数字')
  if (amount < 0) throw new Error('amount 不能为负数')
  if (amount > MAX_AMOUNT) throw new Error('amount 过大（上限 1e15）')
  return amount
}

function parseDirectRate(value) {
  if (value === undefined || value === null) return undefined
  const rate = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('rate 必须是大于 0 的数字（表示 1 单位 from 可兑换多少 to）')
  }
  if (rate < MIN_RATE || rate > MAX_RATE) throw new Error('rate 必须在 1e-12 至 1e12 范围内')
  return rate
}

function buildRateTable(overrides) {
  const table = {}
  for (const [code, info] of Object.entries(CURRENCIES)) table[code] = info.perUsd
  const overridden = []
  if (overrides === undefined || overrides === null) return { table, overridden }
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('rates 必须是对象，例如 {"CNY": 7.2} 表示 1 USD = 7.2 CNY')
  }
  for (const [rawKey, rawValue] of Object.entries(overrides)) {
    const code = normalizeCode(rawKey)
    if (!Object.hasOwn(CURRENCIES, code)) throw new Error('rates 中包含不支持的货币：' + code)
    const value = typeof rawValue === 'string' && rawValue.trim() !== '' ? Number(rawValue) : rawValue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`rates.${code} 必须是大于 0 的数字`)
    }
    if (value < MIN_RATE || value > MAX_RATE) throw new Error('rates.' + code + ' 必须在 1e-12 至 1e12 范围内')
    if (code === 'USD' && value !== 1) throw new Error('rates.USD 必须为 1，因为汇率表以 1 USD 为基准')
    table[code] = value
    overridden.push(code)
  }
  overridden.sort()
  return { table, overridden }
}

function parseTargets(value, fallbackAll) {
  let list
  if (value === undefined || value === null) {
    if (fallbackAll === undefined) throw new Error('缺少 targets（目标货币数组），例如 ["CNY","EUR"]')
    list = fallbackAll
  } else if (Array.isArray(value)) {
    if (value.length === 0) throw new Error('targets 不能是空数组')
    list = value
  } else if (typeof value === 'string') {
    list = value.split(/[\s,，、]+/u).filter(Boolean)
    if (list.length === 0) throw new Error('targets 不能为空')
  } else {
    throw new Error('targets 必须是货币代码数组，例如 ["CNY","EUR"]')
  }
  if (list.length > 60) throw new Error('targets 最多 60 项')
  const codes = []
  for (const item of list) {
    const code = resolveCurrency(item, 'targets')
    if (!codes.includes(code)) codes.push(code)
  }
  return codes
}


function rateSourceFor(codes, overridden) {
  const used = [...new Set(codes)].filter(code => code !== 'USD')
  const custom = used.filter(code => overridden.includes(code)).length
  return custom === 0 ? 'builtin' : custom === used.length ? 'custom' : 'mixed'
}
function rateNote(source) {
  if (source === 'builtin') return SNAPSHOT_NOTE
  if (source === 'mixed') return '本次部分汇率由参数提供，其余仍使用无可验证来源和日期的内置演示数值；实际换算请提供完整汇率。'
  return '汇率来自本次调用参数，仅用于本次换算。'
}

function convertTool(args) {
  const amount = parseAmount(args.amount)
  const from = resolveCurrency(args.from, 'from')
  const to = resolveCurrency(args.to, 'to')
  const { table, overridden } = buildRateTable(args.rates)
  const directRate = parseDirectRate(args.rate)
  if (from === to && directRate !== undefined && directRate !== 1) throw new Error('同币种换算的 rate 必须为 1')
  const rate = directRate !== undefined ? directRate : table[to] / table[from]
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('换算汇率无效，请检查输入的货币与汇率')
  const target = CURRENCIES[to]
  const result = preciseConversion(amount, directRate ?? table[to], directRate === undefined ? table[from] : 1, target.decimals)
  const rateText = directRate !== undefined ? String(directRate) : trimNumber(rate, 6)
  const rateSource = directRate !== undefined ? 'direct' : rateSourceFor([from, to], overridden)
  return {
    amount,
    from,
    fromName: CURRENCIES[from].name,
    to,
    toName: target.name,
    rate: directRate ?? displayRate(table[to], table[from]),
    rateText,
    result,
    resultText: `${formatNumber(result, target.decimals)} ${to}`,
    expression: `${formatAmount(amount)} ${from} × ${rateText} ${expressionSign(amount, rateText, result)} ${formatNumber(result, target.decimals)} ${to}`,
    inverseRate: displayRate(directRate === undefined ? table[from] : 1, directRate ?? table[to]),
    resultDecimals: target.decimals,
    rateSource,
    overriddenRates: overridden,
    note: rateNote(rateSource),
  }
}

function batchConvertTool(args) {
  const amount = parseAmount(args.amount)
  const from = resolveCurrency(args.from, 'from')
  const targets = parseTargets(args.targets)
  const { table, overridden } = buildRateTable(args.rates)
  const results = targets.map((to) => {
    const target = CURRENCIES[to]
    const rate = table[to] / table[from]
    const result = preciseConversion(amount, table[to], table[from], target.decimals)
    return {
      to,
      toName: target.name,
      rate: displayRate(table[to], table[from]),
      rateText: trimNumber(rate, 6),
      result,
      resultText: `${formatNumber(result, target.decimals)} ${to}`,
    }
  })
  return {
    amount,
    from,
    fromName: CURRENCIES[from].name,
    targets,
    count: results.length,
    results,
    rateSource: rateSourceFor([from, ...targets], overridden),
    overriddenRates: overridden,
    note: rateNote(rateSourceFor([from, ...targets], overridden)),
  }
}

function crossTableTool(args) {
  const base = resolveCurrency(args.base, 'base')
  const amount = parseAmount(args.amount, 1)
  const allTargets = Object.keys(CURRENCIES).filter((code) => code !== base)
  const targets = parseTargets(args.targets, allTargets)
  const { table, overridden } = buildRateTable(args.rates)
  const rows = targets.map((to) => {
    const target = CURRENCIES[to]
    const rate = table[to] / table[base]
    const result = preciseConversion(amount, table[to], table[base], target.decimals)
    return {
      code: to,
      name: target.name,
      rate: displayRate(table[to], table[base]),
      rateText: trimNumber(rate, 6),
      result,
      resultText: `${formatNumber(result, target.decimals)} ${to}`,
      inverseRate: displayRate(table[base], table[to]),
    }
  })
  return {
    base,
    baseName: CURRENCIES[base].name,
    amount,
    unit: `${formatAmount(amount)} ${base} 兑换`,
    count: rows.length,
    rows,
    rateSource: rateSourceFor([base, ...targets], overridden),
    overriddenRates: overridden,
    note: rateNote(rateSourceFor([base, ...targets], overridden)),
  }
}

function listCurrenciesTool(args) {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const codes = Object.keys(CURRENCIES).sort()
  const matched = query
    ? codes.filter((code) => {
        const info = CURRENCIES[code]
        const aliases = code === 'CNY' ? '人民币 人民币元 元 圆 RMB ￥ ¥' : code === 'HKD' ? '港币 港元' : ''
        return code.includes(query.toUpperCase()) || info.name.includes(query) || aliases.includes(query)
      })
    : codes
  return {
    total: codes.length,
    count: matched.length,
    query,
    currencies: matched.map((code) => ({
      code,
      name: CURRENCIES[code].name,
      decimals: CURRENCIES[code].decimals,
      perUsd: CURRENCIES[code].perUsd,
      usdPerUnit: displayRate(1, CURRENCIES[code].perUsd),
    })),
    note: SNAPSHOT_NOTE,
  }
}

const TOOLS = {
  convert: convertTool,
  batch_convert: batchConvertTool,
  cross_table: crossTableTool,
  list_currencies: listCurrenciesTool,
}

async function readRequest() {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
  return JSON.parse(input)
}

try {
  const request = await readRequest()
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效请求：需要一个 {tool,args} 对象')
  if (typeof request.tool !== 'string' || !Object.hasOwn(TOOLS, request.tool)) {
    throw new Error('未知工具：' + String(request.tool))
  }
  const args = request.args === undefined || request.args === null ? {} : request.args
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('args 必须是对象')
  const result = TOOLS[request.tool](args)
  process.stdout.write(JSON.stringify({ result }) + '\n')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
