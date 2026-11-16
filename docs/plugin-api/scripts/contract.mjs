/** Read-only engine contract probe. Run only through check.mjs with the paired engine's tsx loader.
 * Imports validators and SDK generators, never application startup, stores, credentials or runtime data.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Pure comparison used by the gate and isolated negative tests. No baseline is mutated. */
export function fingerprintDifferences(before = {}, after = {}) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((file) => before[file] !== after[file])
    .map((file) => ({
      file,
      change: !Object.hasOwn(before, file)
        ? 'added'
        : !Object.hasOwn(after, file)
          ? 'removed'
          : 'changed'
    }))
}

async function probeEngine() {
  const engine = process.argv[2]
  if (!engine) throw new Error('Missing paired engine source directory')
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input || '{}')
  const load = (file) => import(pathToFileURL(path.join(engine, file)).href)
  const [capabilities, contributions, native, sdk, node, service, schema] = await Promise.all([
    load('src/plugins/capabilities.ts'),
    load('src/plugins/contributions.ts'),
    load('src/plugins/native-ui.ts'),
    load('src/plugins/sdk-contract.ts'),
    load('src/plugins/node-sdk.ts'),
    load('src/plugins/service.ts'),
    load('src/plugins/schema.ts')
  ])
  const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  const fields = Object.keys(contributions.pluginContributionsSchema.shape)
  const validated = []
  for (const example of request.examples ?? []) {
    const value = example.value
    try {
      if (
        record(value) &&
        value.apiVersion !== undefined &&
        value.runtime !== undefined &&
        value.tools !== undefined
      ) {
        if (!example.files)
          throw new Error('Complete manifest example has no matching project code blocks')
        service.validatePluginInput({ manifest: value, files: example.files })
        validated.push({
          id: example.id,
          kind: 'complete-project',
          files: Object.keys(example.files)
        })
      } else if (record(value) && value.kind && value.entry) {
        contributions.pluginContributionsSchema.parse({ pages: [value] })
        validated.push({
          id: example.id,
          kind: 'page-declaration',
          scope: 'schema-only; package references are not resolved'
        })
      } else if (
        record(value) &&
        (Object.hasOwn(value, 'root') || example.id.startsWith('content/native.html#'))
      ) {
        // Standalone native examples demonstrate the document schema. Their actions are not installed or run.
        const tools = new Set(),
          commands = new Set()
        const visit = (current) => {
          if (current?.action?.tool) tools.add(current.action.tool)
          if (current?.action?.command) commands.add(current.action.command)
          if (Array.isArray(current?.children)) current.children.forEach(visit)
        }
        const document = Object.hasOwn(value, 'root') ? value : { version: 1, root: value }
        visit(document.root)
        native.validateNativePluginDocument(JSON.stringify(document), tools, commands)
        validated.push({
          id: example.id,
          kind: Object.hasOwn(value, 'root') ? 'native-document' : 'native-node',
          scope:
            'schema-only; action references are collected from this fragment, not validated against a full manifest or executed',
          referencedTools: [...tools],
          referencedCommands: [...commands]
        })
      } else if (record(value) && value.contributes) {
        contributions.pluginContributionsSchema.parse(value.contributes)
        if (value.permissions) capabilities.pluginPermissionsSchema.parse(value.permissions)
        validated.push({
          id: example.id,
          kind: 'contribution-fragment',
          scope: 'schema-only; cross-fragment references are not resolved'
        })
      } else if (
        record(value) &&
        Object.keys(value).length &&
        (Object.keys(value).every((key) => fields.includes(key)) ||
          (example.id.startsWith('content/contributions.html#') && !Object.hasOwn(value, 'result')))
      ) {
        contributions.pluginContributionsSchema.parse(value)
        validated.push({
          id: example.id,
          kind: 'contribution-fragment',
          scope: 'schema-only; cross-fragment references are not resolved'
        })
      } else if (record(value) && (value.permissions || value.requested)) {
        capabilities.pluginPermissionsSchema.parse(value.permissions ?? value)
        validated.push({ id: example.id, kind: 'permissions' })
      } else if (record(value) && value.tool && Object.hasOwn(value, 'args')) {
        const project = request.examples.find(
          (candidate) => candidate.files && candidate.id.split('#')[0] === example.id.split('#')[0]
        )
        const tool = project?.value.tools.find((tool) => tool.name === value.tool)
        if (!tool)
          throw new Error(`Tool input example has no matching declared tool: ${value.tool}`)
        schema.validatePluginArguments(tool.inputSchema, value.args)
        validated.push({ id: example.id, kind: 'tool-input' })
      } else validated.push({ id: example.id, kind: 'json-value' })
    } catch (error) {
      throw new Error(`${example.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  process.stdout.write(
    JSON.stringify({
      sdkTypes: sdk.pluginSdkTypes,
      nodeSdk: node.nodePluginSdk({ pluginId: 'documentation-contract', revision: 1 }),
      inventory: {
        contributions: fields,
        menus: contributions.PLUGIN_MENU_LOCATIONS,
        views: contributions.PLUGIN_VIEW_LOCATIONS,
        events: contributions.PLUGIN_EVENTS,
        permissions: capabilities.PLUGIN_CAPABILITY_IDS,
        native: contributions.PLUGIN_CONTRIBUTION_CATALOGUE.native.componentTypes
      },
      catalogue: contributions.PLUGIN_CONTRIBUTION_CATALOGUE,
      capabilities: capabilities.PLUGIN_CAPABILITIES,
      validated
    })
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await probeEngine()
