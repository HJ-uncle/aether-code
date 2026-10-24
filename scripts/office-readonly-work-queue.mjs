/** Strictly observational adapter over the product JSON journal implementation. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceNames = ['src/shared/next-turn-queue.ts', 'src/shared/next-turn-queue-state.ts', 'src/main/next-turn-queue-store.ts'];
const sha = data => createHash('sha256').update(data).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const cache = new Map();

function sourceGraph(sourcePins) {
  const sources = sourceNames.map(name => {
    const bytes = fs.readFileSync(path.join(repository, name));
    if (bytes.length > 256 * 1024) fail('QUEUE_SOURCE_BYTE_BUDGET');
    const sha256 = sha(bytes);
    if (sourcePins && sourcePins[name] !== sha256) fail('QUEUE_SOURCE_PIN_CHANGED');
    let compiled = cache.get(sha256);
    if (!compiled) {
      compiled = ts.transpileModule(bytes.toString('utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
      if (cache.size > 12) cache.clear();
      cache.set(sha256, compiled);
    }
    return { name, sha256, compiled };
  });
  return { sources, sourceHashes: Object.fromEntries(sources.map(item => [item.name, item.sha256])) };
}
function loadGraph(sources, readOnlyFs) {
  const modules = new Map();
  const aliases = { './next-turn-queue': sourceNames[0], '../shared/next-turn-queue': sourceNames[0], '../shared/next-turn-queue-state': sourceNames[1] };
  const requireModule = name => {
    if (name === 'node:fs') return Object.freeze({ promises: readOnlyFs });
    if (name === 'node:path') return Object.freeze({ join: path.join, resolve: path.resolve });
    if (name === 'node:crypto') return Object.freeze({ createHash, randomUUID });
    const resolved = aliases[name] ?? name;
    if (modules.has(resolved)) return modules.get(resolved);
    const source = sources.find(item => item.name === resolved);
    if (!source) fail('QUEUE_MODULE_NOT_ALLOWED');
    const exports = {};
    modules.set(resolved, exports);
    // Trusted, hash-pinned product source must retain host JSON prototypes: its
    // real schema intentionally rejects cross-realm and exotic objects.
    const factory = new vm.Script(`(function(require,exports){${source.compiled}\n})`, { filename: source.name }).runInThisContext({ timeout: 1500 });
    factory(requireModule, exports);
    return exports;
  };
  for (const name of sourceNames) requireModule(name);
  return { contract: modules.get(sourceNames[1]), Store: modules.get(sourceNames[2]).NextTurnQueueStore };
}

export function createReadonlyWorkQueueReader({ profile, backend, sourcePins, limits = {} }) {
  if (backend !== 'json-journal' || process.env.AETHER_NEXT_TURN_BACKEND === 'sqlite-worker-opt-in') fail('QUEUE_BACKEND_UNSUPPORTED');
  if (!path.isAbsolute(profile) || !samePath(fs.realpathSync(profile), profile) || !fs.statSync(profile).isDirectory()) fail('QUEUE_PROFILE_REDIRECTED');
  const root = path.join(profile, 'next-turn-queue-v1');
  const nativeRoot = path.join(profile, 'next-turn-queue-native-v1');
  const budget = { files: 512, bytes: 16 * 1024 * 1024, directoryNames: 1024, ...limits };
  if (Object.keys(limits).some(key => !['files', 'bytes', 'directoryNames'].includes(key))
    || !Number.isSafeInteger(budget.files) || budget.files < 1 || budget.files > 4096
    || !Number.isSafeInteger(budget.bytes) || budget.bytes < 1 || budget.bytes > 128 * 1024 * 1024
    || !Number.isSafeInteger(budget.directoryNames) || budget.directoryNames < 1 || budget.directoryNames > 6000) fail('QUEUE_READ_BUDGET_INVALID');
  const graph = sourceGraph(sourcePins);
  const emptyFs = Object.freeze({});
  const pure = loadGraph(graph.sources, emptyFs).contract;
  const validateQueueState = (state, scope) => { pure.assertQueueState(state, scope); };
  return Object.freeze({ backend, sourceHashes: graph.sourceHashes, validateQueueState,
    async read(scope) {
      pure.assertQueueScope(scope);
      if (fs.existsSync(nativeRoot)) fail('QUEUE_NATIVE_CATALOG_PRESENT');
      if (!samePath(fs.realpathSync(profile), profile)) fail('QUEUE_PROFILE_CHANGED');
      const bucket = path.join(root, sha(pure.queueScopeIdentity(scope)));
      const meter = { files: 0, bytes: 0, directories: 0 }, files = new Map(), directories = new Map();
      const check = file => {
        const resolved = path.resolve(file);
        if (![root, bucket].some(parent => samePath(resolved, parent)) && !samePath(path.dirname(resolved), bucket)) fail('QUEUE_READ_OUTSIDE_SCOPE');
        for (const directory of [root, bucket]) if (fs.existsSync(directory)) {
          const stat = fs.lstatSync(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) fail('QUEUE_DIRECTORY_REDIRECTED');
        }
        return resolved;
      };
      const ordinary = file => {
        const stat = fs.lstatSync(check(file));
        if (!stat.isFile() || stat.isSymbolicLink() || !samePath(fs.realpathSync(file), file)) fail('QUEUE_FILE_REDIRECTED');
        return stat;
      };
      const readOnlyFs = Object.freeze({
        lstat: async file => fs.promises.lstat(check(file)),
        readdir: async file => {
          const resolved = check(file), names = await fs.promises.readdir(resolved);
          if (names.length > budget.directoryNames) fail('QUEUE_DIRECTORY_BUDGET');
          directories.set(resolved, [...names].sort()); meter.directories++;
          if (meter.directories > 8) fail('QUEUE_DIRECTORY_READ_BUDGET');
          return names;
        },
        readFile: async (file, encoding) => {
          const resolved = check(file), before = ordinary(resolved);
          if (++meter.files > budget.files || meter.bytes + before.size > budget.bytes) fail('QUEUE_READ_BUDGET_EXCEEDED');
          meter.bytes += before.size;
          const bytes = await fs.promises.readFile(resolved), after = ordinary(resolved);
          if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('QUEUE_FILE_CHANGED_DURING_READ');
          files.set(resolved, { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, sha256: sha(bytes) });
          return encoding === 'utf8' ? bytes.toString('utf8') : bytes;
        },
      });
      const { Store } = loadGraph(graph.sources, readOnlyFs);
      const reader = new Store(root);
      // Even error diagnostics cannot write: fs only contains the three observed
      // read methods above. The production reader still validates the entire chain.
      const value = await reader.read(scope);
      for (const [file, before] of files) {
        const after = ordinary(file);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('QUEUE_FILE_CHANGED_AFTER_READ');
      }
      for (const [directory, names] of directories) {
        const after = (await fs.promises.readdir(check(directory))).sort();
        if (JSON.stringify(after) !== JSON.stringify(names)) fail('QUEUE_DIRECTORY_CHANGED_AFTER_READ');
      }
      if (!directories.size && fs.existsSync(bucket)) fail('QUEUE_BUCKET_APPEARED_DURING_READ');
      const state = JSON.parse(JSON.stringify(value.state));
      validateQueueState(state, scope);
      return { state, sourceHashes: graph.sourceHashes, backend, readEvidence: { bucket, ...meter,
        files: [...files].map(([file, info]) => ({ file, ...info })), auxiliaryFiles: [...value.auxiliaryFiles],
        semantics: 'Complete product journal validation through read-only filesystem capabilities; no owner bind, recover, retry, mutation or diagnostic write.' } };
    },
  });
}
