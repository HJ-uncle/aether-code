import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { build, destination, project } from './build.mjs'

build()
const zip = new JSZip()
const files = JSON.parse(fs.readFileSync(path.join(destination, '.generated-files.json'), 'utf8'))
for (const name of files) {
  const filename = path.resolve(destination, name)
  if (!filename.startsWith(destination + path.sep) || fs.lstatSync(filename).isSymbolicLink()) throw new Error('Invalid generated file')
  zip.file(name, fs.readFileSync(filename))
}
const output = path.resolve(project, '../../.e2e-tmp/plugin-api-site')
fs.mkdirSync(output, { recursive: true })
const filename = path.join(output, 'aether-plugin-api-reference.zip')
fs.writeFileSync(filename, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
console.log(`已打包 ${files.length} 个公开文件：${filename}`)
