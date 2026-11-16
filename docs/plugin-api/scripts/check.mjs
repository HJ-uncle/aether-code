/** Maintainer gate for the public HTML reference. Default: read/check; never refresh the reviewed baseline.
 * After reviewing source changes and updating affected HTML, explicitly run with --accept-reviewed.
 * Standalone static-site builds do not need the engine; this source-contract check intentionally does.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fingerprintDifferences } from './contract.mjs'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.resolve(site, '../..')
const engine = path.resolve(
  process.env.AETHER_ENGINE_SOURCE_DIR || path.join(frontend, '../ai-agent-engine')
)
const snapshotFile = path.join(site, 'contract.snapshot.json')
const reportFile = path.join(frontend, '.e2e-tmp/plugin-api-site/contract-check.json')
const accept = process.argv.includes('--accept-reviewed')
const checks = []
const report = {
  status: 'failed',
  mode: accept ? 'accept-reviewed' : 'check',
  checkedAt: new Date().toISOString(),
  checks
}
const read = (file) => fs.readFileSync(file, 'utf8')
const slash = (file) => file.split(path.sep).join('/')
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const checked = (name, detail) => checks.push({ name, detail })
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sorted = (items) => [...new Set(items)].sort()
const same = (actual, expected, label) => assert.deepEqual(sorted(actual), sorted(expected), label)
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function walk(directory) {
  const result = []
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      item.isSymbolicLink() ||
      /^(?:node_modules|dist|out|coverage|test|tests|e2e|__tests__|__fixtures__|fixtures|\.git|\.e2e-tmp)$/.test(
        item.name
      )
    )
      continue
    const filename = path.join(directory, item.name)
    if (item.isDirectory()) result.push(...walk(filename))
    else if (item.isFile()) result.push(filename)
  }
  return result
}

/** Discover integration points afresh: adding/removing a mount is itself a reviewed change. */
function sourceFingerprints() {
  // Session approval semantics are shared infrastructure outside plugin modules.
  const files = Object.fromEntries([
    'src/tools/management/approved-mutation.ts',
    'src/security/policy-engine.ts',
    'src/core/stream-pipeline/public-pending.ts',
    'src/workspace/manager.ts',
    'src/tools/workbench/bridge.ts'
  ].map(relative => [`engine/${relative}`, hash(path.join(engine, relative))]))
  files['frontend/src/renderer/src/core/workbench/client.ts'] = hash(path.join(frontend, 'src/renderer/src/core/workbench/client.ts'))
  const hostCalls =
    /\b(?:ExtensionSlot|ExtensionPage|useExtensionMenuItems|useExtensionContributions|useExtensionEditorDecorations|registerExtensionTarget|publishExtensionEvent|subscribeExtensionEvents|PluginBrowserSurface|pluginContributionsSchema|PluginCapabilityRuntime|PluginLifecycleRuntime|dispatchPluginEvent|runPlugin|emitAgentLifecycleEvent|publishRootAgentEvent|observeExtensionMessages|publishFileMutation|subscribeFileMutations)\b/
  for (const [name, root] of [
    ['frontend', frontend],
    ['engine', engine]
  ]) {
    for (const file of walk(path.join(root, 'src'))) {
      const relative = slash(path.relative(root, file))
      if (
        !/\.(?:[cm]?ts|tsx|[cm]?js|jsx|css)$/.test(file) ||
        /(?:\.test|\.spec)\.[^.]+$/.test(file)
      )
        continue
      const pluginModule =
        name === 'engine'
          ? /^src\/plugins\//.test(relative) ||
            /\/(?:plugin[^/]*|[^/]*plugin)\.[^.]+$/.test(relative)
          : /^src\/renderer\/src\/features\/(?:extensions|plugins|services)\//.test(relative) ||
            /\/(?:plugin[^/]*|[^/]*plugin)\.[^.]+$/.test(relative)
      const source = read(file)
      const imports = [...source.matchAll(/(?:from\s*|import\s*\()["']([^"']+)["']/g)].map(
        (match) => match[1]
      )
      const integration =
        imports.some((module) =>
          module
            .split('/')
            .some((part) => /^(?:plugins?(?:\.|$)|plugin-|extensions(?:\.|$))/.test(part))
        ) ||
        /["'`][^"'`\n]*\/plugins(?:[/?"'`])/.test(source) ||
        hostCalls.test(source)
      if (pluginModule || integration) files[`${name}/${relative}`] = hash(file)
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

function documentFingerprints() {
  return Object.fromEntries(
    walk(site)
      .filter((file) => file !== snapshotFile && /\.(?:html|css|js|mjs|json)$/.test(file))
      .map((file) => [slash(path.relative(site, file)), hash(file)])
      .sort(([a], [b]) => a.localeCompare(b))
  )
}

function methodPaths(value, prefix = '') {
  return Object.entries(value).flatMap(([key, item]) => {
    const name = prefix ? `${prefix}.${key}` : key
    return typeof item === 'function'
      ? [name]
      : item && typeof item === 'object'
        ? methodPaths(item, name)
        : []
  })
}

function pureModule(ts, relative, dependencies = {}) {
  const file = path.join(frontend, relative)
  const compiled = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInNewContext(
    compiled,
    {
      exports,
      TextEncoder,
      require: (name) => {
        assert.ok(
          Object.hasOwn(dependencies, name),
          `Unexpected import ${name} in pure contract module ${relative}`
        )
        return dependencies[name]
      }
    },
    { filename: file, timeout: 3000 }
  )
  return exports
}

function declaredMethods(ts, declaration, name) {
  const node = declaration.statements.find(
    (item) => ts.isInterfaceDeclaration(item) && item.name.text === name
  )
  assert.ok(node, `Missing generated SDK interface ${name}`)
  const visit = (members, prefix = '') =>
    members.flatMap((member) => {
      if (!member.name) return []
      const key = member.name.getText(declaration).replace(/^['"]|['"]$/g, '')
      const full = prefix ? `${prefix}.${key}` : key
      if (ts.isMethodSignature(member)) return [full]
      if (ts.isPropertySignature(member) && member.type && ts.isTypeLiteralNode(member.type))
        return visit(member.type.members, full)
      return []
    })
  return visit(node.members)
}

function frontendDeclarations(ts, inventory) {
  const source = ts.createSourceFile(
    'plugin-contributions.ts',
    read(path.join(frontend, 'src/shared/plugin-contributions.ts')),
    ts.ScriptTarget.Latest,
    true
  )
  const aliases = new Map(
    source.statements.filter(ts.isTypeAliasDeclaration).map((item) => [item.name.text, item.type])
  )
  const values = (node) => {
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(values)
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text]
    if (ts.isTypeReferenceNode(node) && aliases.has(node.typeName.getText(source)))
      return values(aliases.get(node.typeName.getText(source)))
    throw new Error(`Unrecognized public event/location declaration: ${node.getText(source)}`)
  }
  for (const [type, key] of [
    ['PluginMenuLocation', 'menus'],
    ['PluginViewLocation', 'views'],
    ['PluginEventName', 'events']
  ]) {
    assert.ok(aliases.has(type), `Missing frontend ${type}`)
    same(values(aliases.get(type)), inventory[key], `Frontend ${type} vs engine`)
  }
  const hostEvents = values(aliases.get('PluginHostEventName'))
  assert.ok(
    hostEvents.every((event) => inventory.events.includes(event) && !event.startsWith('agent.')),
    'Host event type must not admit forged engine agent lifecycle facts'
  )
  const contribution = source.statements.find(
    (item) => ts.isInterfaceDeclaration(item) && item.name.text === 'PluginContributions'
  )
  assert.ok(contribution, 'Missing frontend PluginContributions')
  same(
    contribution.members.map((member) => member.name.getText(source)),
    inventory.contributions,
    'Frontend contribution fields vs engine schema'
  )
}

function projectFiles(example, blocks) {
  const manifest = example.value
  const files = {}
  const explicit = blocks.filter((block) => block.file)
  for (const block of explicit) files[block.file] = block.text
  const entries = sorted(manifest.tools.map((tool) => tool.entry))
  const scripts = blocks.filter(
    (block) => !block.file && ['js', 'javascript', 'mjs'].includes(block.language)
  )
  const missing = entries.filter((file) => !Object.hasOwn(files, file))
  assert.equal(
    scripts.length,
    missing.length,
    `${example.id}: give project code blocks data-file attributes when source-to-entry mapping is ambiguous`
  )
  missing.forEach((file, index) => {
    files[file] = scripts[index].text
  })
  const pages = (manifest.contributes?.pages ?? []).filter((page) => page.kind !== 'tool')
  const html = blocks.filter((block) => !block.file && block.language === 'html')
  const native = blocks.filter(
    (block) =>
      !block.file && block.language === 'json' && block.value?.version === 1 && block.value?.root
  )
  for (const [kind, source] of [
    ['webview', html],
    ['native', native]
  ]) {
    const targets = sorted(
      pages.filter((page) => page.kind === kind).map((page) => page.entry)
    ).filter((file) => !Object.hasOwn(files, file))
    assert.equal(
      source.length,
      targets.length,
      `${example.id}: ${kind} example files are missing or ambiguous`
    )
    targets.forEach((file, index) => {
      files[file] = source[index].text
    })
  }
  return files
}

try {
  assert.ok(
    process.argv.slice(2).every((arg) => arg === '--accept-reviewed'),
    'Usage: node docs/plugin-api/scripts/check.mjs [--accept-reviewed]'
  )
  assert.ok(
    fs.existsSync(path.join(engine, 'src/plugins/sdk-contract.ts')),
    `Paired engine source is missing at ${engine}. Set AETHER_ENGINE_SOURCE_DIR to its checkout; static docs:build remains independent of the engine.`
  )
  const frontendRequire = createRequire(path.join(frontend, 'package.json'))
  const engineRequire = createRequire(path.join(engine, 'package.json'))
  const ts = frontendRequire('typescript')
  let parseFragment, loader
  try {
    ;({ parseFragment } = await import(pathToFileURL(engineRequire.resolve('parse5')).href))
    loader = engineRequire.resolve('tsx/esm')
  } catch (error) {
    throw new Error(
      `Install the paired engine's development dependencies before contract checking: ${error.message}`
    )
  }
  const { pages } = await import(pathToFileURL(path.join(site, 'pages.mjs')).href)
  assert.ok(Array.isArray(pages) && pages.length, 'pages.mjs must export a nonempty pages array')
  const expectedPages = [
    'overview',
    'manifest',
    'platform',
    'page',
    'contributions',
    'native',
    'events',
    'permissions'
  ]
  for (const id of expectedPages)
    assert.ok(
      pages.some((page) => page.id === id),
      `Missing reference page ${id}`
    )
  assert.equal(new Set(pages.map((page) => page.id)).size, pages.length, 'Duplicate page IDs')
  assert.equal(
    new Set(pages.map((page) => page.file)).size,
    pages.length,
    'Duplicate page output files'
  )
  const documents = new Map(),
    byOutput = new Map(),
    examples = []
  const text = (node) =>
    node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('')
  const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value
  for (const page of pages) {
    assert.match(page.id, /^[a-z][a-z0-9-]*$/, 'Unsafe page ID')
    assert.match(page.file, /^[a-z][a-z0-9-]*\.html$/, 'Public pages must live at the output root')
    const relative = `content/${page.id}.html`,
      source = read(path.join(site, relative))
    const htmlErrors = []
    const parsed = parseFragment(source, { onParseError: (error) => htmlErrors.push(error.code) })
    assert.deepEqual(htmlErrors, [], `${relative}: malformed HTML`)
    assert.doesNotMatch(
      source + '\n' + text(parsed),
      /ai-agent-engine|\.e2e-tmp|\/api\/v\d|scripts\/(?:diagnostics|plugin)|src\/(?:plugins|renderer|main|shared)|[A-Z]:[\\/](?:dev|web)[\\/]|\bHTTP\s+API\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/(?:plugins|api)\b/i,
      `Internal engine paths/HTTP API leaked into ${relative}`
    )
    const document = {
      ...page,
      relative,
      source,
      anchors: new Set(),
      headings: [],
      links: [],
      blocks: [],
      codes: []
    }
    const visit = (node) => {
      const id = attr(node, 'id')
      if (id) {
        assert.ok(!document.anchors.has(id), `${relative}: duplicate anchor #${id}`)
        document.anchors.add(id)
      }
      if (['h2', 'h3'].includes(node.tagName)) {
        assert.ok(id, `${relative}: heading requires an explicit id: ${text(node)}`)
        document.headings.push({ id, text: text(node).trim() })
      }
      if (node.tagName === 'a' && attr(node, 'href') !== undefined)
        document.links.push(attr(node, 'href'))
      if (node.tagName === 'script')
        throw new Error(
          `${relative}: content fragments cannot execute scripts; escape HTML examples in code blocks`
        )
      if (node.tagName === 'code') {
        const value = text(node)
        document.codes.push(value)
        const language =
          /(?:^|\s)language-([\w-]+)/.exec(attr(node, 'class') ?? '')?.[1] ??
          attr(node, 'data-language')
        if (language) {
          const block = {
            language,
            text: value,
            file: attr(node, 'data-file'),
            id: `${relative}#example-${document.blocks.length + 1}`
          }
          if (language === 'json') {
            block.value = JSON.parse(value)
            examples.push(block)
          }
          document.blocks.push(block)
        }
      }
      for (const child of node.childNodes ?? []) visit(child)
    }
    visit(parsed)
    documents.set(page.id, document)
    byOutput.set(page.file, document)
  }
  let links = 0
  for (const document of documents.values()) {
    for (const href of document.links) {
      if (/^(?:https?:|mailto:)/i.test(href)) continue
      assert.ok(
        href && !/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href),
        `${document.relative}: unsafe local link ${href}`
      )
      const url = new URL(href, `https://reference.invalid/${document.file}`)
      const relative = decodeURIComponent(url.pathname.slice(1)),
        anchor = decodeURIComponent(url.hash.slice(1))
      const target = byOutput.get(relative)
      if (target) {
        if (anchor)
          assert.ok(target.anchors.has(anchor), `${document.relative}: missing anchor ${href}`)
      } else {
        const filename = path.resolve(site, relative)
        assert.ok(
          relative.startsWith('assets/') &&
            filename.startsWith(site + path.sep) &&
            fs.existsSync(filename) &&
            !anchor,
          `${document.relative}: missing local page/resource ${href}`
        )
      }
      links++
    }
    for (const block of document.blocks)
      if (
        record(block.value) &&
        block.value.apiVersion !== undefined &&
        block.value.runtime !== undefined &&
        block.value.tools !== undefined
      )
        block.files = projectFiles(block, document.blocks)
  }
  checked('HTML source, anchors, local links and strict JSON', {
    pages: documents.size,
    links,
    jsonBlocks: examples.length
  })
  const initialSources = sourceFingerprints(),
    initialDocuments = documentFingerprints()
  if (!accept && fs.existsSync(snapshotFile)) {
    const previous = JSON.parse(read(snapshotFile))
    report.unreviewed = {
      sources: fingerprintDifferences(previous.sources, initialSources),
      documents: fingerprintDifferences(previous.documents, initialDocuments)
    }
  }
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(loader).href, path.join(site, 'scripts/contract.mjs'), engine],
    {
      cwd: engine,
      input: JSON.stringify({ examples }),
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOTENV_CONFIG_PATH: path.join(frontend, '.e2e-tmp/plugin-api-site/no-environment-file')
      }
    }
  )
  assert.equal(
    result.status,
    0,
    `Read-only engine contract probe failed: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`
  )
  const contract = JSON.parse(result.stdout)
  assert.ok(
    contract.validated.some((example) => example.kind === 'complete-project'),
    'Reference must contain a complete validated plugin project'
  )
  assert.ok(
    contract.validated.some((example) => example.kind === 'native-document'),
    'Reference must contain a complete native JSON document'
  )
  checked('Examples through shipped engine validators (no plugin execution)', contract.validated)

  const nodeContext = vm.createContext({ process: { on() {}, channel: { unref() {} } } })
  vm.runInContext(contract.nodeSdk, nodeContext, { timeout: 3000 })
  const nodeMethods = methodPaths(nodeContext.$AE)
  const theme = pureModule(ts, 'src/shared/plugin-ui.ts')
  const webview = pureModule(ts, 'src/renderer/src/features/extensions/webview-document.ts', {
    '@shared/plugin-ui': theme
  })
  const bridge = webview
    .extensionWebviewDocument('', 'documentation-contract')
    .match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(bridge, 'Generated webview bridge is missing')
  const pageContext = vm.createContext({ window: {}, addEventListener() {} })
  vm.runInContext(bridge, pageContext, { timeout: 3000 })
  const pageMethods = methodPaths(pageContext.window.$AE)
  const declaration = ts.createSourceFile(
    'aether-sdk.d.ts',
    contract.sdkTypes,
    ts.ScriptTarget.Latest,
    true
  )
  same(
    nodeMethods,
    declaredMethods(ts, declaration, 'AetherPluginSDK'),
    'Node SDK runtime vs generated types'
  )
  same(
    pageMethods,
    [...nodeMethods, ...declaredMethods(ts, declaration, 'AetherPluginPageSDK')],
    'Page runtime vs generated types'
  )
  same(
    pageMethods,
    contract.catalogue.webview.bridge,
    'Public discovery directory vs webview runtime'
  )
  frontendDeclarations(ts, contract.inventory)
  const docCode = (id) => documents.get(id).codes.join('\n')
  for (const method of pageMethods) {
    const source = nodeMethods.includes(method)
      ? docCode('platform')
      : docCode('page') + '\n' + docCode('events')
    assert.match(
      source,
      new RegExp('(?:^|[^\\w$.])(?:window\\.)?(?:\\$AE\\.)?' + escape(method) + '\\s*\\('),
      `Missing documented SDK method ${method}`
    )
  }
  for (const document of documents.values())
    for (const match of document.codes
      .join('\n')
      .matchAll(/\$AE\.([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)*)\s*\(/g)) {
      assert.ok(
        pageMethods.includes(match[1]),
        `${document.relative}: documented SDK method does not exist: ${match[1]}`
      )
    }
  for (const capability of contract.capabilities)
    for (const advertised of capability.bridge)
      if (advertised.startsWith('$AE.')) {
        const method = advertised.slice(4)
        assert.ok(
          pageMethods.some((name) => name === method || name.startsWith(method + '.')),
          `Permission advertises missing bridge ${advertised}`
        )
      }
  for (const [key, page] of [
    ['permissions', 'permissions'],
    ['menus', 'contributions'],
    ['views', 'contributions'],
    ['events', 'events'],
    ['native', 'native']
  ]) {
    const words = documents.get(page).codes
    for (const item of contract.inventory[key])
      assert.ok(
        words.some((code) => code.trim() === item),
        `Missing ${key} reference entry ${item} in ${page}.html`
      )
  }
  for (const name of contract.inventory.contributions) {
    const id = name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())
    assert.ok(
      documents
        .get('contributions')
        .headings.some((heading) => heading.id === id || heading.text === name),
      `Missing contribution section ${name}`
    )
  }
  same(
    contract.inventory.contributions,
    contract.catalogue.fields,
    'Contribution schema vs discovery catalogue'
  )
  const native = pureModule(ts, 'src/renderer/src/features/extensions/native-document.ts')
  for (const example of examples) {
    const validated = contract.validated.find((value) => value.id === example.id)
    if (validated?.kind === 'native-document')
      native.parseNativeDocument(JSON.stringify(example.value))
    else if (validated?.kind === 'native-node')
      native.parseNativeDocument(JSON.stringify({ version: 1, root: example.value }))
  }
  const nativeSource = ts.createSourceFile(
    'native-document.ts',
    read(path.join(frontend, 'src/renderer/src/features/extensions/native-document.ts')),
    ts.ScriptTarget.Latest,
    true
  )
  const nativeNode = nativeSource.statements.find(
    (item) => ts.isInterfaceDeclaration(item) && item.name.text === 'NativeNode'
  )
  const nativeType = nativeNode?.members.find(
    (member) => member.name?.getText(nativeSource) === 'type'
  )?.type
  assert.ok(
    nativeType && ts.isUnionTypeNode(nativeType),
    'Missing frontend native component vocabulary'
  )
  same(
    nativeType.types.map((type) => type.literal.text),
    contract.inventory.native,
    'Frontend native component types vs engine'
  )
  const inventory = {
    methods: sorted(pageMethods),
    sharedMethods: sorted(nodeMethods),
    ...contract.inventory
  }
  report.inventory = inventory
  checked(
    'Live SDK, generated declarations, schema catalogues and HTML coverage',
    Object.fromEntries(Object.entries(inventory).map(([name, values]) => [name, values.length]))
  )

  const sources = sourceFingerprints(),
    documentsFingerprint = documentFingerprints()
  assert.deepEqual(
    sources,
    initialSources,
    'Source files changed during verification; rerun against a stable tree'
  )
  assert.deepEqual(
    documentsFingerprint,
    initialDocuments,
    'Documentation changed during verification; rerun after editing completes'
  )
  const current = { version: 1, inventory, sources, documents: documentsFingerprint }
  report.fingerprints = { sources, documents: documentsFingerprint }
  if (accept) {
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify({ ...current, reviewedAt: new Date().toISOString() }, null, 2) + '\n'
    )
    checked('Explicitly accepted reviewed source/document fingerprints', {
      sources: Object.keys(sources).length,
      documents: Object.keys(documentsFingerprint).length
    })
  } else {
    assert.ok(
      fs.existsSync(snapshotFile),
      'Reviewed contract snapshot is missing. Review the HTML against current sources, then explicitly run check.mjs --accept-reviewed.'
    )
    const previous = JSON.parse(read(snapshotFile))
    assert.equal(
      previous.version,
      current.version,
      'Unsupported contract snapshot version; explicit review required'
    )
    const changes = {
      sources: fingerprintDifferences(previous.sources, sources),
      documents: fingerprintDifferences(previous.documents, documentsFingerprint)
    }
    report.unreviewed = changes
    const pending = [
      ...changes.sources.map((change) => `${change.change}: ${change.file}`),
      ...changes.documents.map((change) => `${change.change}: docs/plugin-api/${change.file}`)
    ]
    assert.ok(
      !pending.length,
      `Plugin API changes need documentation review:\n${pending.join('\n')}\nUpdate the affected HTML, then use --accept-reviewed only after review. Default check never rewrites the baseline.`
    )
    assert.deepEqual(
      previous.inventory,
      inventory,
      'Live API inventory differs from the reviewed contract'
    )
    checked('Reviewed source/document fingerprints unchanged', {
      sources: Object.keys(sources).length,
      documents: Object.keys(documentsFingerprint).length
    })
  }
  report.status = 'passed'
  console.log(
    `Plugin HTML contract: passed (${pageMethods.length} SDK methods, ${contract.inventory.contributions.length} contributions, ${contract.inventory.permissions.length} permissions).`
  )
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  console.error(`Plugin HTML contract: failed\n${report.error}`)
  if (
    report.unreviewed?.sources.length &&
    !report.error.includes('Plugin API changes need documentation review')
  ) {
    console.error(
      'Unreviewed source files:\n' +
        report.unreviewed.sources.map((change) => `${change.change}: ${change.file}`).join('\n')
    )
  }
  process.exitCode = 1
} finally {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true })
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
}
