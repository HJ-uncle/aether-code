const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  Module = require('node:module'),
  ts = require('typescript')
const cache = new Map()
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const native = Module.createRequire(file)
  const requireLocal = (name) =>
    name.startsWith('.')
      ? load(path.resolve(path.dirname(file), name.endsWith('.ts') ? name : name + '.ts'))
      : native(name)
  vm.runInThisContext('(function(exports,require,module,__filename,__dirname){' + output + '\n})', {
    filename: file
  })(module.exports, requireLocal, module, file, path.dirname(file))
  return module.exports
}
const { NextTurnQueueStore } = load(
  path.resolve(__dirname, '../../src/main/next-turn-queue-store.ts')
)
const { NextTurnQueueMutationService } = load(
  path.resolve(__dirname, '../../src/main/next-turn-queue-service.ts')
)
let config, release
process.on('message', async (message) => {
  if (message.type === 'release') {
    release?.()
    return
  }
  if (message.type !== 'start' || config) return
  config = message
  let service
  try {
    if (message.fault === 'close-before-fsync' || message.fault === 'write-path-is-directory') {
      const originalOpen = fs.promises.open.bind(fs.promises)
      fs.promises.open = async (file, ...args) => {
        if (String(file).includes('stage-') && message.fault === 'write-path-is-directory')
          await fs.promises.mkdir(file)
        const handle = await originalOpen(file, ...args)
        if (String(file).includes('stage-') && message.fault === 'close-before-fsync') {
          const originalWrite = handle.writeFile.bind(handle)
          handle.writeFile = async (...writeArgs) => {
            await originalWrite(...writeArgs)
            await handle.close()
          }
        }
        return handle
      }
    }
    const store = new NextTurnQueueStore(message.root, {
      testHook: async (context) => {
        if (message.fault === 'rename-target-is-directory' && context.phase === 'after-stage-fsync')
          await fs.promises.mkdir(context.ready)
        if (context.phase === message.holdAt) {
          process.send({
            type: 'barrier',
            phase: context.phase,
            stage: context.stage,
            ready: context.ready,
            committed: context.committed
          })
          await new Promise((resolve) => {
            release = resolve
          })
        }
      }
    })
    service = new NextTurnQueueMutationService(store, {
      capture: async (taskId) => ({
        scope: { ...message.scope, taskId },
        generation: 'owned-fixture'
      }),
      assertCurrent: () => {}
    })
    const capability = await service.bind(message.scope.taskId)
    const result = await service.mutate(
      capability,
      message.expectedRevision,
      message.operationId,
      message.operation
    )
    await service.close()
    process.send({
      type: 'result',
      ok: true,
      result,
      serviceClosed: true,
      diagnostics: service.diagnostics()
    })
  } catch (error) {
    if (service) await service.close()
    process.send({
      type: 'result',
      ok: false,
      serviceClosed: Boolean(service),
      diagnostics: service?.diagnostics(),
      error: {
        name: error.name,
        code: error.code,
        message: error.message,
        evidencePath: error.evidencePath
      }
    })
  }
  process.disconnect()
})
