import type { PluginManifest } from '../../src/renderer/src/core/engine/plugins'
import JSZip from 'jszip'

/** Deliberately independent probe fixtures; production creates from engine templates. */
export function pluginSource(resultExpression = 'JSON.stringify(args)'): string {
  return `import process from 'node:process'\n\nlet input = ''\nfor await (const chunk of process.stdin) input += chunk\nconst { args } = JSON.parse(input)\nprocess.stdout.write(JSON.stringify({ result: { text: ${resultExpression} } }) + '\\n')\n`
}
export function newPlugin(): { manifest: PluginManifest; files: Record<string, string> } {
  return { manifest: { apiVersion: 1, id: 'my-plugin', name: '我的插件', version: '1.0.0', description: '描述这个插件的用途。', runtime: 'node',
    tools: [{ name: 'greet', description: '根据名字生成问候语。', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }, entry: 'tools/greet.mjs' }] },
    files: { 'tools/greet.mjs': pluginSource('`你好，${args.name}！`') } }
}

/** Real ZIP bytes make input-file and batch-preview fixtures exercise the same wire shape. */
export async function pluginArchive(id: string, name: string): Promise<Buffer> {
  const template = newPlugin(), manifest = { ...template.manifest, id, name }, zip = new JSZip()
  zip.file('aether-plugin.json', JSON.stringify(manifest))
  for (const [file,content] of Object.entries(template.files)) zip.file(file,content)
  return zip.generateAsync({ type: 'nodebuffer' })
}
