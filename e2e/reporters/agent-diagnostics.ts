import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult
} from '@playwright/test/reporter'
import { relative } from 'node:path'

/**
 * Agent 失败诊断 reporter
 *
 * 为什么需要它：Playwright 默认输出是「给人看的散文」——报错、堆栈、
 * 附件路径散在几十行里，Agent 每次失败都要重新解析一遍，还容易漏掉关键信息。
 * 这里在每轮结束时把失败聚合成固定字段的块，字段名稳定、可直接 grep，
 * Agent 读一次就能拿到「改完要复跑哪条命令」和「环境说了什么」。
 *
 * 设计约束：
 * - 不重复默认 list reporter 的信息，只补它没说的（可复现命令、环境能力、渲染进程报错）
 * - 只在有失败时输出，全绿时保持安静（否则噪声又回来了）
 * - 环境能力缺失（skip）单独成节，避免和"代码坏了"混为一谈
 */

const DIVIDER = '─'.repeat(72)

/** 从 stdout/stderr 里捞出应用自身的报错。测试自己的 console.log 不在此列。 */
function extractAppErrors(text: string): string[] {
  const lines = text.split('\n')
  const hits: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // 应用侧前缀与 Playwright 的附件提示做区分
    if (
      trimmed.includes('[terminal]') ||
      trimmed.includes('PAGEERROR') ||
      trimmed.startsWith('Uncaught ') ||
      /^Error: Error invoking remote method/.test(trimmed)
    ) {
      hits.push(trimmed)
    }
  }
  // 同一错误重复几十次（如重试风暴）时只留一条 + 计数，避免刷屏
  const counts = new Map<string, number>()
  for (const hit of hits) counts.set(hit, (counts.get(hit) ?? 0) + 1)
  return [...counts.entries()].map(([hit, count]) => (count > 1 ? `${hit}   (×${count})` : hit))
}

/** 同一条用例可能因多条 expect 失败，errors 里逐条记录 */
function formatErrors(result: TestResult): string[] {
  const out: string[] = []
  for (const error of result.errors) {
    const message = error.message ?? ''
    // 只保留首段：Playwright 的消息后面跟着大段 locator 日志，对定位无用
    const head = message.split('\n').slice(0, 6).join('\n').trimEnd()
    out.push(head)
  }
  return out
}

export default class AgentDiagnosticsReporter implements Reporter {
  private failed: { test: TestCase; result: TestResult }[] = []
  private skipped: { test: TestCase; reason: string }[] = []
  private startedAt = 0

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now()
    void suite
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'failed' || result.status === 'timedOut') {
      this.failed.push({ test, result })
    } else if (result.status === 'skipped') {
      this.skipped.push({ test, reason: test.annotations[0]?.description ?? '未注明原因' })
    }
  }

  onEnd(result: FullResult): void {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1)

    // 环境能力缺失单独报：这不是回归，Agent 不应据此改代码
    if (this.skipped.length > 0) {
      console.log(`\n${DIVIDER}`)
      console.log('ENV-CAPABILITY-SKIPS 以下用例因当前环境不具备所需能力而跳过，非代码缺陷：')
      for (const { test, reason } of this.skipped) {
        console.log(`  - ${test.title}`)
        console.log(`    原因: ${reason}`)
      }
    }

    if (this.failed.length === 0) {
      console.log(`\n${DIVIDER}`)
      console.log(`AGENT-SUMMARY status=${result.status} failed=0 elapsed=${elapsed}s`)
      return
    }

    console.log(`\n${DIVIDER}`)
    console.log(
      `AGENT-SUMMARY status=${result.status} failed=${this.failed.length} elapsed=${elapsed}s`
    )
    console.log(`${DIVIDER}`)

    this.failed.forEach(({ test, result }, index) => {
      const file = relative(process.cwd(), test.location.file).replace(/\\/g, '/')
      const line = test.location.line
      // 复现命令用 -g 精确匹配标题：标题含特殊字符时 grep 仍安全
      const grep = test.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

      console.log(`\nFAILURE #${index + 1}`)
      console.log(`  title:    ${test.title}`)
      console.log(`  file:     ${file}:${line}`)
      console.log(`  status:   ${result.status}`)
      console.log(`  repro:    npx playwright test ${file} -g "${grep}" --reporter=list`)
      console.log('  errors:')
      for (const err of formatErrors(result)) {
        for (const line2 of err.split('\n')) console.log(`    ${line2}`)
      }

      // stdout/stderr 是 (string | Buffer)[]，拼成一整段文本再交给 extractAppErrors 按行扫
      const appErrors = extractAppErrors(
        [...result.stdout, ...result.stderr]
          .map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf-8')))
          .join('\n')
      )
      if (appErrors.length > 0) {
        console.log('  app-errors:   渲染进程/主进程侧报错（测试断言之外的真实信号）')
        for (const err of appErrors) console.log(`    ${err}`)
      }

      const trace = result.attachments.find((item) => item.name === 'trace')
      if (trace?.path) {
        console.log(
          `  trace:    npx playwright show-trace "${relative(process.cwd(), trace.path)}"`
        )
      }
    })

    console.log(`\n${DIVIDER}`)
    console.log('提示：先用 repro 复跑单条；若 app-errors 为空且 errors 只与选择器有关，')
    console.log('      多半是 UI 结构变了而用例没跟上，改用例前先确认实现侧的意图。')
  }
}
