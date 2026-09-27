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

/**
 * 二进制预览与 git 展示的纯函数测试
 *
 * 两者都是"把原始字节/字段翻译成人能看的东西"，出错时不会崩、
 * 只会静悄悄显示错内容，所以必须用确定的输入把输出钉死。
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
