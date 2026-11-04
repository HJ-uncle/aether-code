/** Read-only browser check of a generated local document index and its links. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { chromium } from '@playwright/test'

const [sourceArg, outArg] = process.argv.slice(2)
assert.ok(sourceArg && outArg, 'Expected source workspace and new output directory')
const source = resolve(sourceArg), out = resolve(outArg)
assert.ok(!existsSync(out), 'Refusing to overwrite evidence'); mkdirSync(out, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { source, boundary: 'Independent headless Chromium; real link clicks and local HTTP responses. Office rendering is verified separately in Electron.', links: [], views: [], errors: [] }
const progress = stage => { report.stage = stage; writeFileSync(join(out, 'progress.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ stage, links: report.links.length })) }
const server = createServer((req, res) => {
  try {
    assert.equal(req.method, 'GET')
    const file = resolve(source, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname))
    assert.ok(file.startsWith(source + sep))
    const bytes = readFileSync(file)
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' })[extname(file)] || 'application/octet-stream' }); res.end(bytes)
  } catch { res.writeHead(404); res.end('Not found') }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const index = origin + '/product/' + encodeURIComponent('文档索引.html')
let browser
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const context = await browser.newContext({ acceptDownloads: true })
  context.setDefaultTimeout(15000)
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.errors.push(error.message))
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(index)
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, contentWidth: document.documentElement.scrollWidth }))
    report.views.push({ width, ...geometry, screenshot: join(out, `index-${width}.png`) })
    await page.screenshot({ path: join(out, `index-${width}.png`), fullPage: true })
    if (geometry.contentWidth > width + 1) report.errors.push(`Horizontal overflow at ${width}: ${geometry.contentWidth}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(index)
  const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(a => ({ text: a.textContent, href: a.getAttribute('href'), url: a.href })))
  for (const [i, link] of links.entries()) {
    assert.equal(new URL(link.url).origin, origin)
    const file = resolve(source, '.' + decodeURIComponent(new URL(link.url).pathname))
    assert.ok(file.startsWith(source + sep)); const original = readFileSync(file)
    // PDF's built-in viewer may commit after its response arrives. An independent
    // page per link prevents that navigation from racing the next index visit.
    const linkPage = await context.newPage()
    try {
      progress(`link-${i + 1}-start`)
      await linkPage.goto(index)
      const received = linkPage.waitForResponse(response => response.url() === link.url)
      await linkPage.locator('a[href]').nth(i).click({ noWaitAfter: true })
      const response = await received; assert.equal(response.status(), 200)
      const checked = await context.request.get(link.url)
      assert.equal(sha(await checked.body()), sha(original))
      report.links.push({ ...link, source: file, sha256: sha(original), clickedStatus: response.status(), bytes: original.length })
      progress(`link-${i + 1}-verified`)
    } finally {
      await Promise.race([linkPage.close(), new Promise(done => setTimeout(done, 2000))])
    }
  }
  assert.equal(report.errors.length, 0, 'Document index has visual/runtime errors')
} catch (error) { report.failure = error.message; process.exitCode = 1 }
finally {
  progress('closing')
  if (browser) await browser.close()
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, links: report.links.length, errors: report.errors, failure: report.failure }))
}
