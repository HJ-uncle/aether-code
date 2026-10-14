const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module'), ts = require('typescript')
const cache = new Map()
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const native = Module.createRequire(file)
  const local = name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name.endsWith('.ts') ? name : name + '.ts')) : native(name)
  vm.runInThisContext('(function(exports,require,module,__filename,__dirname){' + output + '\n})', { filename: file })(module.exports, local, module, file, path.dirname(file))
  return module.exports
}
let started = false, release
process.on('message', async message => {
  if (message.type === 'release') { release?.(); return }
  if (message.type !== 'start' || started) return
  started = true
  let service
  try {
    const source = message.sourceRoot || path.resolve(__dirname, '../../')
    const { NextTurnQueueStore } = load(path.join(source, 'src/main/next-turn-queue-store.ts'))
    const { NextTurnQueueMutationService } = load(path.join(source, 'src/main/next-turn-queue-service.ts'))
    const store = new NextTurnQueueStore(message.root, {
      limits: message.limits,
      testHook: async context => {
        if (context.phase !== message.holdAt) return
        process.send({ type: 'barrier', phase: context.phase, committed: context.committed, ready: context.ready })
        await new Promise(resolve => { release = resolve })
      }
    })
    service = new NextTurnQueueMutationService(store, { capture: async taskId => ({ scope: { ...message.scope, taskId }, generation: 'archive-test-owner' }), assertCurrent: () => {} })
    const cap = await service.bind(message.scope.taskId)
    const result = message.readOnly ? await service.read(cap) : await service.mutate(cap, message.expectedRevision, message.operationId, message.operation)
    await service.close()
    process.send({ type: 'result', ok: true, result, serviceClosed: true, diagnostics: service.diagnostics() })
  } catch (error) {
    if (service) await service.close()
    process.send({ type: 'result', ok: false, error: { code: error.code, message: error.message }, serviceClosed: Boolean(service), diagnostics: service?.diagnostics() })
  }
  process.disconnect()
})
