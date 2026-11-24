/**
 * Aether 应用图标生成器。
 *
 * 设计：「AE 协作字标」—— Aether 的 A 与 Code 的 E 由同一组圆角轨道构成，
 *       A 的开放结构代表探索，E 的三条横轨代表代码与工作区；不依赖泛 AI 符号。
 *       SVG 母版位于 src/renderer/src/assets/aether-logo.svg，图标生成与渲染层共用这一事实来源。
 *
 * 为什么用 Electron 而不是 sharp / ImageMagick：
 *   SVG 母版直接交给 Chromium 的 canvas 按目标尺寸精确栅格化，
 *   不需要任何新增依赖（本机无 ImageMagick / Inkscape，仓库也无 sharp）。
 *   Electron 本身就是本项目的既有依赖，零成本。
 *
 * 为什么用矢量母版而不是位图：
 *   逐尺寸渲染可控、可复现，改一处颜色/比例即可全量重出；
 *   同一母版可以用于应用图标、菜单栏品牌位和后续官网/插件入口。
 *
 * 用法（在仓库根目录）：
 *   node_modules\electron\dist\electron.exe scripts\icon\generate-icons.cjs
 *
 * 产出（全部以 aether-logo.svg 为唯一事实来源）：
 *   build/icon.png        512×512   Linux 打包图标
 *   build/icon.ico        16/24/32/48/64/128/256   Windows 打包 + exe/快捷方式/安装器
 *   build/icon.icns       16/32/64/128/256/512/1024  macOS 打包
 *   resources/icon.png    512×512   主进程运行时窗口图标（Linux）
 *   src/renderer/src/assets/icon.png  128×128  渲染进程菜单栏品牌图标
 *
 * 注意：resources/icon.png 被 e2e/smoke.spec.ts 当作「稳定的真实 PNG」夹具使用，
 *       文件名不可更改。
 */
const { app, BrowserWindow } = require('electron')
const { writeFileSync, readFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..', '..')
const LOG = join(ROOT, 'build', 'icon-generate.log')

// Windows 下 Electron 是 GUI 子系统进程，stdout 不回附终端，
// 因此日志一律落盘，排查时读 build/icon-generate.log。
const lines = []
function note(msg) {
  lines.push(msg)
  console.log(msg)
}
function flushLog(extra) {
  try {
    mkdirSync(join(ROOT, 'build'), { recursive: true })
    writeFileSync(LOG, [...lines, ...(extra ? [extra] : [])].join('\n') + '\n')
  } catch {
    /* 日志写不出不应影响主流程 */
  }
}

// ─────────────────────────────────────────────────────────────
// 母版矢量图（唯一事实来源）
// ─────────────────────────────────────────────────────────────
const ARTWORK = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'assets', 'aether-logo.svg'), 'utf8')

// ─────────────────────────────────────────────────────────────
// ICO / ICNS 打包（均为「内嵌 PNG」容器格式，无需图像库）
// ─────────────────────────────────────────────────────────────

/** 组装 PNG-in-ICO。width/height 为 256 时按规范写 0。 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((e, i) => {
    const b = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1)
    dir.writeUInt8(0, b + 2) // palette
    dir.writeUInt8(0, b + 3) // reserved
    dir.writeUInt16LE(1, b + 4) // color planes
    dir.writeUInt16LE(32, b + 6) // bits per pixel
    dir.writeUInt32LE(e.png.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += e.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/** 组装 PNG-in-ICNS。每个条目以 4 字节类型码 + 4 字节长度开头。 */
function buildIcns(entries) {
  const chunks = entries.map((e) => {
    const head = Buffer.alloc(8)
    head.write(e.type, 0, 4, 'ascii')
    head.writeUInt32BE(e.png.length + 8, 4)
    return Buffer.concat([head, e.png])
  })
  const body = Buffer.concat(chunks)

  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

// ─────────────────────────────────────────────────────────────
// 栅格化：隐藏窗口里用 canvas 把矢量母版按目标尺寸绘制
// ─────────────────────────────────────────────────────────────

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  window.__raster = function (svg, size) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = size; c.height = size;
        var ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        resolve(c.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = function () { reject(new Error('SVG 解码失败')); };
      // 显式给宽高，否则部分 SVG 会以 0×0 加载
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  };
</script></body></html>`

async function main() {
  // 关掉窗口时不得让默认的 window-all-closed 提前退出进程，
  // 否则写盘步骤会被跳过（曾因此静默产出 0 字节变更）。
  app.on('window-all-closed', () => {})

  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: { backgroundThrottling: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))

  // 一次算全所有需要的边长，避免重复栅格化
  const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
  note('正在栅格化: ' + SIZES.join('/') + ' px')
  const png = new Map()
  for (const size of SIZES) {
    const b64 = await win.webContents.executeJavaScript(
      `window.__raster(${JSON.stringify(ARTWORK)}, ${size})`
    )
    png.set(size, Buffer.from(b64, 'base64'))
  }
  win.destroy()

  const ico = buildIco(
    [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png.get(size) }))
  )

  const icns = buildIcns([
    { type: 'icp4', png: png.get(16) },
    { type: 'icp5', png: png.get(32) },
    { type: 'icp6', png: png.get(64) },
    { type: 'ic07', png: png.get(128) },
    { type: 'ic08', png: png.get(256) },
    { type: 'ic09', png: png.get(512) },
    { type: 'ic10', png: png.get(1024) },
    { type: 'ic11', png: png.get(32) },
    { type: 'ic12', png: png.get(64) },
    { type: 'ic13', png: png.get(256) },
    { type: 'ic14', png: png.get(512) }
  ])

  mkdirSync(join(ROOT, 'build'), { recursive: true })
  mkdirSync(join(ROOT, 'resources'), { recursive: true })
  mkdirSync(join(ROOT, 'src', 'renderer', 'src', 'assets'), { recursive: true })

  const targets = [
    [join(ROOT, 'build', 'icon.png'), png.get(512)],
    [join(ROOT, 'resources', 'icon.png'), png.get(512)],
    // 渲染进程用的副本：菜单栏品牌位直接 import 这张图，
    // 走 vite 资源管线打包，与打包图标共用同一份母版，改母版即全量重出
    [join(ROOT, 'src', 'renderer', 'src', 'assets', 'icon.png'), png.get(128)],
    [join(ROOT, 'build', 'icon.ico'), ico],
    [join(ROOT, 'build', 'icon.icns'), icns]
  ]
  for (const [path, buf] of targets) {
    writeFileSync(path, buf)
    note(`  ${path}  ${buf.length} bytes`)
  }

  note('完成：5 个图标文件已更新')
  flushLog()
  app.exit(0)
}

main().catch((err) => {
  flushLog('失败: ' + (err && err.stack ? err.stack : String(err)))
  app.exit(1)
})



