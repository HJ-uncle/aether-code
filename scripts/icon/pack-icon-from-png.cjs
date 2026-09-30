/**
 * 把 AI 生成的图标位图打包成产品所需的四个图标文件（零依赖版）。
 *
 * 为什么用 Electron 而不是 sharp：
 *   本机无 Python / ImageMagick / Inkscape；Wuzu 客户端自带的 sharp 缺
 *   detect-libc 依赖、require 不起来。仓库既有 Electron 的 Chromium canvas
 *   本身就能做「圆角矩形裁剪 + 缩放重采样」，零新增依赖。
 *
 * 流程：
 *   1. 源 PNG（AI 图，圆角外是纯白像素）按圆角矩形 clip 后绘制，
 *      白色角自然被裁掉（canvas clip 之外的区域保持透明）；
 *   2. 按各目标尺寸重采样；
 *   3. 打包 ICO / ICNS（纯 Buffer 拼装，无需图像库）。
 *
 * 用法（在仓库根目录）：
 *   node_modules\electron\dist\electron.exe scripts\icon\pack-icon-from-png.cjs <源png路径>
 *
 * 产出：
 *   build/icon.png / build/icon.ico / build/icon.icns / resources/icon.png
 */
'use strict'
const { app, BrowserWindow } = require('electron')
const { writeFileSync, readFileSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = join(__dirname, '..', '..')
const LOG = join(ROOT, 'build', 'icon-pack.log')

// Windows 下 Electron 是 GUI 子系统进程，stdout 不回附终端，日志一律落盘。
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

// 圆角半径占边长比例（与 macOS 圆角矩形观感接近，也和矢量母版 rx=230/1024 一致）
const RADIUS_RATIO = 230 / 1024

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  window.__pack = function (dataUrl, size, radiusRatio) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = size; c.height = size;
        var ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, size, size);
        var r = size * radiusRatio;
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(0, 0, size, size, r); }
        else {
          ctx.moveTo(r, 0); ctx.arcTo(size, 0, size, size, r);
          ctx.arcTo(size, size, 0, size, r); ctx.arcTo(0, size, 0, 0, r);
          ctx.arcTo(0, 0, size, 0, r); ctx.closePath();
        }
        ctx.clip();
        ctx.drawImage(img, 0, 0, size, size);
        resolve(c.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = function () { reject(new Error('PNG 解码失败')); };
      img.src = dataUrl;
    });
  };
</script></body></html>`

/** 组装 PNG-in-ICO。width/height 为 256 时按规范写 0。 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((e, i) => {
    const b = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1)
    dir.writeUInt8(0, b + 2)
    dir.writeUInt8(0, b + 3)
    dir.writeUInt16LE(1, b + 4)
    dir.writeUInt16LE(32, b + 6)
    dir.writeUInt32LE(e.png.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += e.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/** 组装 PNG-in-ICNS。 */
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

async function main() {
  const srcPath = process.argv[2]
  if (!srcPath) {
    note('用法: node_modules\\electron\\dist\\electron.exe scripts/icon/pack-icon-from-png.cjs <源png路径>')
    flushLog()
    app.exit(1)
    return
  }
  const absSrc = resolve(ROOT, srcPath)
  const src = readFileSync(absSrc)
  note('源图: ' + absSrc + '  ' + src.length + ' bytes')
  const dataUrl = 'data:image/png;base64,' + src.toString('base64')

  // 关掉窗口时不得让默认的 window-all-closed 提前退出进程
  app.on('window-all-closed', () => {})
  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: { backgroundThrottling: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))

  const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
  note('正在圆角裁剪 + 重采样: ' + SIZES.join('/') + ' px')
  const png = new Map()
  for (const size of SIZES) {
    const b64 = await win.webContents.executeJavaScript(
      `window.__pack(${JSON.stringify(dataUrl)}, ${size}, ${RADIUS_RATIO})`
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
  const targets = [
    [join(ROOT, 'build', 'icon.png'), png.get(512)],
    [join(ROOT, 'resources', 'icon.png'), png.get(512)],
    [join(ROOT, 'build', 'icon.ico'), ico],
    [join(ROOT, 'build', 'icon.icns'), icns]
  ]
  for (const [p, buf] of targets) {
    writeFileSync(p, buf)
    note('  ' + p + '  ' + buf.length + ' bytes')
  }
  note('完成：4 个图标文件已更新')
  flushLog()
  app.exit(0)
}

main().catch((err) => {
  flushLog('失败: ' + (err && err.stack ? err.stack : String(err)))
  app.exit(1)
})
