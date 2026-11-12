import type { PluginManifest } from '../../src/renderer/src/core/engine/plugins'

/** Deliberately independent probe fixtures; production creates from engine templates. */
export function pluginSource(resultExpression = 'JSON.stringify(args)'): string {
  return `import process from 'node:process'\n\nlet input = ''\nfor await (const chunk of process.stdin) input += chunk\nconst { args } = JSON.parse(input)\nprocess.stdout.write(JSON.stringify({ result: { text: ${resultExpression} } }) + '\\n')\n`
}
export function newPlugin(): { manifest: PluginManifest; files: Record<string, string> } {
  return { manifest: { apiVersion: 1, id: 'my-plugin', name: '我的插件', version: '1.0.0', description: '描述这个插件的用途。', runtime: 'node',
    tools: [{ name: 'greet', description: '根据名字生成问候语。', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }, entry: 'tools/greet.mjs' }] },
    files: { 'tools/greet.mjs': pluginSource('`你好，${args.name}！`') } }
}
