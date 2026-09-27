import { expect, test } from '@playwright/test'
import {
  DEFAULT_HEX_BYTES,
  base64ToBytes,
  extensionOf,
  formatSize,
  hexDump,
  mimeFor,
  previewKindFor,
  toDataUrl
} from '../src/renderer/src/core/editor/preview'
import {
  changeCode,
  changeTitle,
  formatCommitDate,
  normalizeGitPath,
  splitRefs,
  summarizeChanges
} from '../src/renderer/src/core/git/git-format'
import { compileExclude, isExcluded } from '../src/renderer/src/core/workspace/exclude'
import { DEFAULT_SEARCH_EXCLUDE } from '../src/shared/ipc'
import {
  compileSearchExclude,
  isSearchExcluded,
  mergeSearchExclude,
  toGitPathspec
} from '../src/main/search/exclude'

/**
 * 纯函数测试：二进制预览 + git 展示格式化 + 文件/搜索排除匹配。
 *
 * 本文件覆盖：preview.ts（MIME 判定 / 预览类型 / 十六进制转储 / data URL）
 * 与 git-format.ts（改动码与标题 / 提交日期 / refs 拆分 / 路径归一 / 变更摘要）
 * 与 workspace/exclude.ts（files.exclude 的 glob 匹配）
 * 与 main/search/exclude.ts（search.exclude 的 glob 匹配与 git pathspec 归一）。
 *
 * 这些都是"把原始字节/字段翻译成人能看的东西"，出错时不会崩、
 * 只会静悄悄显示错内容，所以必须用确定的输入把输出钉死。
 *
 * 这些用例不需要真实应用：除 shared/ipc 只取常量外，模块都不触碰 window.aether，
 * 因此由 Playwright 的 TS 加载器直接编译执行，跑起来远快于真机用例。
 */

/** PNG 文件头（真实字节），用来钉死十六进制格式 */
const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
])

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

test.describe('类型判定', () => {
  test('取扩展名', () => {
    expect(extensionOf('a.PNG')).toBe('png')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })

  test('MIME 只对已知类型给出值', () => {
    expect(mimeFor('a.png')).toBe('image/png')
    expect(mimeFor('a.mp4')).toBe('video/mp4')
    expect(mimeFor('a.bin')).toBeNull()
  })

  test('预览方式分流：图片 / 视频 / 其余一律十六进制', () => {
    expect(previewKindFor('logo.png')).toBe('image')
    expect(previewKindFor('clip.webm')).toBe('video')
    expect(previewKindFor('app.exe')).toBe('hex')
    expect(previewKindFor('font.ttf')).toBe('hex')
    // 没有扩展名时不能瞎猜
    expect(previewKindFor('LICENSE')).toBe('hex')
  })

  test('SVG 不在图片映射里（它是文本，应走编辑器而不是图片预览）', () => {
    expect(mimeFor('icon.svg')).toBeNull()
    expect(previewKindFor('icon.svg')).toBe('hex')
  })

  test('data URL 带正确 MIME；未知类型回退 octet-stream', () => {
    expect(toDataUrl('AAAA', 'a.png')).toBe('data:image/png;base64,AAAA')
    expect(toDataUrl('AAAA', 'a.bin')).toBe('data:application/octet-stream;base64,AAAA')
  })
})

test.describe('base64ToBytes', () => {
  test('完整解码', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255])
    expect([...base64ToBytes(toBase64(bytes))]).toEqual([0, 1, 2, 250, 255])
  })

  test('只解码前 N 字节，用于只取文件头', () => {
    const bytes = Uint8Array.from(Array.from({ length: 100 }, (_, i) => i))
    const head = base64ToBytes(toBase64(bytes), 10)
    expect(head).toHaveLength(10)
    expect([...head]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('切片不会切断 base64 组（不被 3 整除的长度同样正确）', () => {
    const bytes = Uint8Array.from(Array.from({ length: 7 }, (_, i) => 100 + i))
    // 4 字节不是 3 的倍数，对齐逻辑必须仍然解码出正确前缀
    expect([...base64ToBytes(toBase64(bytes), 4)]).toEqual([100, 101, 102, 103])
  })
})

test.describe('hexDump', () => {
  test('满行格式与 xxd 习惯一致（偏移、双列、ASCII 列）', () => {
    const dump = hexDump(PNG_HEADER)
    expect(dump).toBe(
      '00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|'
    )
  })

  test('不可打印字节显示为点；跨列时保留双空格分栏', () => {
    // 'Hello' 之后的 NUL / 0x01 / 0x7f / 0xff 都不可打印，一律显示为点。
    // 第 9 个字节（0xff）落在第二列，因此 0x7f 与它之间是两空格的分栏间距。
    const bytes = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x01, 0x7f, 0xff])
    const line = hexDump(bytes)

    expect(line.startsWith('00000000  48 65 6c 6c 6f 00 01 7f  ff')).toBe(true)
    expect(line).toContain('|Hello....')
    expect(line.endsWith('|')).toBe(true)
  })

  test('超过 maxBytes 时只输出前一段，并说明截断', () => {
    const bytes = Uint8Array.from(Array.from({ length: 64 }, () => 0x41))
    const dump = hexDump(bytes, 16)

    expect(dump.split('\n')).toHaveLength(1)
    expect(dump).toContain('00000000')
    expect(dump).not.toContain('00000010')
  })

  test('空文件返回空串而不是抛错', () => {
    expect(hexDump(new Uint8Array())).toBe('')
  })

  test('默认上限是 16 KB（避免把大文件全量转成文本）', () => {
    expect(DEFAULT_HEX_BYTES).toBe(16 * 1024)
  })
})

test.describe('formatSize', () => {
  test('按量级选择单位', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})

test.describe('git 展示格式', () => {
  test('未跟踪显示 U，其余优先显示暂存列', () => {
    expect(changeCode({ path: 'a', indexStatus: '?', workTreeStatus: '?', staged: false })).toBe(
      'U'
    )
    expect(changeCode({ path: 'a', indexStatus: 'M', workTreeStatus: ' ', staged: true })).toBe('M')
    expect(changeCode({ path: 'a', indexStatus: ' ', workTreeStatus: 'D', staged: false })).toBe(
      'D'
    )
  })

  test('角标提示把 XY 两位的含义写清楚', () => {
    expect(
      changeTitle({ path: 'a', indexStatus: '?', workTreeStatus: '?', staged: false })
    ).toContain('未跟踪')
    const title = changeTitle({ path: 'a', indexStatus: 'M', workTreeStatus: 'M', staged: true })
    expect(title).toContain('暂存区 M')
    expect(title).toContain('工作区 M')
    expect(title).toContain('已暂存')
  })

  test('路径分隔符统一为正斜杠（git 输出本就是 /）', () => {
    expect(normalizeGitPath('src\\a\\b.ts')).toBe('src/a/b.ts')
    expect(normalizeGitPath('src/a.ts')).toBe('src/a.ts')
  })

  test('提交时间格式化到分钟；无法解析时原样返回而不是清空', () => {
    // 用本地时区无关的方式断言年份/日期部分：ISO 含时区，格式化后是本地时间
    const formatted = formatCommitDate('2026-09-21T12:34:41+02:00')
    expect(formatted).toMatch(/^2026-09-2\d \d{2}:\d{2}$/)

    expect(formatCommitDate('not-a-date')).toBe('not-a-date')
  })

  test('引用装饰拆成列表并去掉 HEAD -> 前缀', () => {
    expect(splitRefs('HEAD -> main, origin/main, origin/HEAD')).toEqual([
      'main',
      'origin/main',
      'origin/HEAD'
    ])
    expect(splitRefs('')).toEqual([])
    expect(splitRefs('v1.0.0')).toEqual(['v1.0.0'])
  })

  test('改动汇总文案', () => {
    expect(summarizeChanges({ changes: [] })).toBe('无改动')
    expect(
      summarizeChanges({
        changes: [{ path: 'a', indexStatus: 'M', workTreeStatus: ' ', staged: true }]
      })
    ).toBe('1 处改动')
  })
})

test.describe('文件排除（files.exclude）', () => {
  /** 便捷断言：把规则表编译后判断某相对路径是否被隐藏 */
  const hidden = (
    exclude: Record<string, boolean>,
    relPath: string,
    parentHidden = false
  ): boolean => {
    const name = relPath.split('/').pop() ?? relPath
    return isExcluded(compileExclude(exclude), relPath, name, parentHidden)
  }

  test('带双星前缀的规则命中任意层级的同名项', () => {
    const rules = { '**/.git': true }
    expect(hidden(rules, '.git')).toBe(true)
    expect(hidden(rules, 'src/.git')).toBe(true)
    expect(hidden(rules, 'a/b/c/.git')).toBe(true)
    // 只匹配整段名字，不匹配「包含」
    expect(hidden(rules, 'a/.gitignore')).toBe(false)
    expect(hidden(rules, 'my.git')).toBe(false)
  })

  test('裸写的模式按前缀补双星，放宽为「任意层级」', () => {
    // 这是本项目与 VS Code 的唯一语义差别：VS Code 里裸写只挡顶层，
    // 这里跟随用户直觉放宽 —— 但绝不能因此变成子串匹配。
    expect(hidden({ node_modules: true }, 'node_modules')).toBe(true)
    expect(hidden({ node_modules: true }, 'packages/app/node_modules')).toBe(true)
    expect(hidden({ node_modules: true }, 'node_modules_old')).toBe(false)
    expect(hidden({ node_modules: true }, 'src/node_modules.ts')).toBe(false)
  })

  test('单星不跨分隔符，只匹配一段路径', () => {
    expect(hidden({ '*.log': true }, 'a.log')).toBe(true)
    expect(hidden({ '*.log': true }, 'src/deep/a.log')).toBe(true)
    expect(hidden({ '*.log': true }, 'src/a.log')).toBe(true)
    // 单星不吃斜杠，所以带目录的写法在整段路径上对不上
    expect(hidden({ 'src/*.log': true }, 'src/a.log')).toBe(true)
    expect(hidden({ 'src/*.log': true }, 'src/deep/a.log')).toBe(false)
  })

  test('路径型规则按相对根的路径匹配，不会误伤别处同名目录', () => {
    const rules = { 'src/generated': true }
    expect(hidden(rules, 'src/generated')).toBe(true)
    expect(hidden(rules, 'src/generated/x.ts', false)).toBe(false)
    // 带分隔符的规则约束了层级，别处同名目录不受影响
    expect(hidden(rules, 'other/generated')).toBe(false)
  })

  test('问号匹配单个字符且不跨分隔符', () => {
    expect(hidden({ 'file?.txt': true }, 'file1.txt')).toBe(true)
    expect(hidden({ 'file?.txt': true }, 'fileA.txt')).toBe(true)
    expect(hidden({ 'file?.txt': true }, 'file12.txt')).toBe(false)
    expect(hidden({ 'file?.txt': true }, 'file.txt')).toBe(false)
  })

  test('值为 false 的规则不隐藏任何东西', () => {
    expect(hidden({ '**/.git': false }, '.git')).toBe(false)
    expect(hidden({ '**/.git': false }, 'src/.git')).toBe(false)
  })

  test('父级被隐藏时子树一律隐藏', () => {
    // parentHidden 由调用方沿树链传下来，规则本身对深层路径无感也能生效
    expect(hidden({}, 'node_modules/a/b.js', true)).toBe(true)
    // 目录规则本身只看名字，深层路径不会被规则直接命中，靠 parentHidden 传播
    expect(hidden({ '**/dist': true }, 'dist/out/a.js', false)).toBe(false)
    expect(hidden({ '**/dist': true }, 'dist/out/a.js', true)).toBe(true)
  })

  test('空表或残缺表不隐藏任何东西', () => {
    expect(hidden({}, 'node_modules')).toBe(false)
    expect(hidden({ '': true }, 'anything')).toBe(false)
    expect(hidden({ '   ': true }, 'anything')).toBe(false)
  })

  test('末尾的斜杠与斜杠加双星都只表示「目录及其内容」', () => {
    expect(hidden({ 'build/': true }, 'build')).toBe(true)
    expect(hidden({ 'build/**': true }, 'build')).toBe(true)
    expect(hidden({ 'build/**': true }, 'build/out/a.js')).toBe(false)
    // 目录规则靠 parentHidden 传播到内容，规则本身不必吃掉内部路径
    expect(hidden({ 'build/**': true }, 'build/out/a.js', true)).toBe(true)
  })

  test('正则元字符按字面匹配，不会被当成语法', () => {
    expect(hidden({ 'a+b.txt': true }, 'a+b.txt')).toBe(true)
    expect(hidden({ 'a+b.txt': true }, 'aab.txt')).toBe(false)
    expect(hidden({ '(x).md': true }, '(x).md')).toBe(true)
  })

  test('反斜杠路径在匹配前统一成正斜杠', () => {
    const rules = compileExclude({ 'src/generated': true })
    expect(isExcluded(rules, 'src\\generated', 'generated', false)).toBe(true)
  })
})

test.describe('搜索排除（search.exclude）', () => {
  /** 便捷断言：与主进程 walkScan 的用法一致（目录命中即剪枝，不做父级传播） */
  const skipped = (exclude: Record<string, boolean>, relPath: string): boolean => {
    const name = relPath.split('/').pop() ?? relPath
    return isSearchExcluded(compileSearchExclude(exclude), relPath, name)
  }

  test('默认三条规则挡住依赖与索引目录', () => {
    expect(skipped(DEFAULT_SEARCH_EXCLUDE, 'node_modules')).toBe(true)
    expect(skipped(DEFAULT_SEARCH_EXCLUDE, 'packages/app/node_modules')).toBe(true)
    expect(skipped(DEFAULT_SEARCH_EXCLUDE, '.code-search')).toBe(true)
    expect(skipped(DEFAULT_SEARCH_EXCLUDE, 'src/index.ts')).toBe(false)
  })

  test('目录命中即剪枝，因此规则不必吃掉目录内部路径', () => {
    // 这是搜索侧与资源管理器侧的关键差别：不做父级传播，靠调用方命中目录后不再下钻
    expect(skipped({ '**/dist': true }, 'dist')).toBe(true)
    expect(skipped({ '**/dist': true }, 'dist/out/a.js')).toBe(false)
  })

  test('值为 false 时不排除，用来把继承来的规则放回来', () => {
    expect(skipped({ '**/node_modules': false }, 'node_modules')).toBe(false)
  })

  test('并集：search 侧同名键覆盖 files 侧', () => {
    const merged = mergeSearchExclude(
      { '**/.git': true, '**/node_modules': true },
      { '**/node_modules': false, '**/dist': true }
    )
    expect(merged['**/node_modules']).toBe(false)
    expect(merged['**/.git']).toBe(true)
    expect(merged['**/dist']).toBe(true)
    expect(skipped(merged, 'node_modules')).toBe(false)
    expect(skipped(merged, '.git')).toBe(true)
    expect(skipped(merged, 'dist')).toBe(true)
  })

  test('pathspec：裸写放宽为任意层级，并额外补一条排除目录内容', () => {
    // git 的 pathspec 只认路径匹配，挡了目录本身挡不住目录里的文件，
    // 因此一条模式出两条：同名路径 + 其下所有内容
    expect(toGitPathspec('node_modules')).toEqual([
      ':(exclude,glob)**/node_modules',
      ':(exclude,glob)**/node_modules/**'
    ])
    expect(toGitPathspec('src/generated')).toEqual([
      ':(exclude,glob)src/generated',
      ':(exclude,glob)src/generated/**'
    ])
    // 末尾的斜杠双星先裁掉再补，避免出现三级双星
    expect(toGitPathspec('build/**')).toEqual([
      ':(exclude,glob)**/build',
      ':(exclude,glob)**/build/**'
    ])
  })

  test('pathspec：空模式与根锚定模式跳过（交给 git 会语义不同）', () => {
    expect(toGitPathspec('')).toEqual([])
    expect(toGitPathspec('   ')).toEqual([])
    expect(toGitPathspec('/src')).toEqual([])
  })
})
