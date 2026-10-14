const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module'), ts = require('typescript')
const cache = new Map()
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const native = Module.createRequire(file), local = name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name.endsWith('.ts') ? name : name + '.ts')) : native(name)
  vm.runInThisContext('(function(exports,require,module,__filename,__dirname){' + output + '\n})', { filename: file })(module.exports, local, module, file, path.dirname(file))
  return module.exports
}
let started = false, release
process.on('message', async message => {
  if (message.type === 'release') { release?.(); return }
  if (message.type !== 'start' || started) return
  started = true
  let store
  try {
    const { NextTurnQueueSqliteExperiment } = load(path.resolve(__dirname, '../../src/main/next-turn-queue-sqlite-experiment.ts'))
    store = new NextTurnQueueSqliteExperiment(message.file, { nativeExperimentOnly: true, testHook: async phase => { if (phase !== message.holdAt) return; process.send({ type: 'barrier', phase }); await new Promise(done => { release = done }) } })
    const result = await store.mutate(message.scope, message.expectedRevision, message.operationId, message.operation, () => {})
    await store.close()
    process.send({ type: 'result', ok: true, result, closeJoined: true })
  } catch (error) { if (store) await store.close(); process.send({ type: 'result', ok: false, error: { code: error.code, message: error.message }, closeJoined: true }) }
  process.disconnect()
})
