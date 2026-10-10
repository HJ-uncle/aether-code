/** Actual IDE/SDK launchers -> built engine bootstrap -> project child; also legacy runtime binding. Build engine first. */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startProcess as startIdeProcess } from '../src/main/engine/sdk/process-manager'
import { startProcess as startSdkProcess } from '../../ai-agent-engine/sdk-package/src/embedded/processManager'

const tempRoot = resolve(__dirname, '../.e2e-tmp')
let fixture: string
let script: string
let legacyScript: string

test.beforeAll(() => {
  mkdirSync(tempRoot, { recursive: true })
  fixture = mkdtempSync(join(tempRoot, 'engine-process-env-'))
  script = join(fixture, 'environment.cjs')
  const bootstrapUrl = pathToFileURL(resolve(__dirname, '../../ai-agent-engine/dist/env.js')).href
  writeFileSync(script, `
    async function main() {
    await import(${JSON.stringify(bootstrapUrl)});
    const {spawnSync}=require('node:child_process');
    const project=spawnSync(process.execPath,['-e',
      'process.stdout.write(JSON.stringify({port:process.env.PORT??null,host:process.env.HOST??null,selectedPort:Number(process.env.PORT||8765),bootstrapMarker:process.env.AETHER_ENGINE_PROJECT_ENV??null}))'
    ],{encoding:'utf8',windowsHide:true,env:{...process.env}});
    if(project.status!==0) throw new Error(project.stderr||'Project child failed');
    process.stdout.write(JSON.stringify({enginePort:process.env.AETHER_ENGINE_PORT,engineHost:process.env.AETHER_ENGINE_HOST,project:JSON.parse(project.stdout)}));
    }
    main().catch(error=>{console.error(error);process.exitCode=1});
  `)
  legacyScript = join(fixture, 'legacy-environment.cjs')
  writeFileSync(legacyScript, `
    const server=require('node:net').createServer();
    server.on('error',error=>{console.error(error);process.exitCode=1});
    server.listen(Number(process.env.PORT||12323),process.env.HOST||'0.0.0.0',()=>{
      const address=server.address();
      process.stdout.write(JSON.stringify({enginePort:String(address.port),engineHost:address.address}));
      server.close();
    });
  `)
})

test.afterAll(() => {
  if (!fixture) return
  if (dirname(fixture) !== tempRoot || !basename(fixture).startsWith('engine-process-env-')) throw new Error('Unsafe fixture cleanup')
  rmSync(fixture, { recursive: true, force: true })
})

interface ObservedEnvironment {
  enginePort: string
  engineHost: string
  project: { port: string | null; host: string | null; selectedPort: number; bootstrapMarker: string | null }
}

async function inspectLauncher(start: typeof startSdkProcess, parent: Record<string, string>, caller: Record<string, string> = {}, binPath = script): Promise<ObservedEnvironment> {
  const keys = ['PORT', 'HOST', 'AETHER_ENGINE_PORT', 'AETHER_ENGINE_HOST', 'AETHER_ENGINE_PROJECT_ENV']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) {
    if (parent[key] === undefined) delete process.env[key]
    else process.env[key] = parent[key]
  }
  let handle: ReturnType<typeof startSdkProcess> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    handle = start({ binPath, port: 12479, env: caller })
    let stdout = '', stderr = ''
    handle.process.stdout?.on('data', chunk => { stdout += chunk.toString() })
    handle.process.stderr?.on('data', chunk => { stderr += chunk.toString() })
    const exitCode = await Promise.race([
      new Promise<number | null>((done, reject) => { handle!.process.once('exit', done); handle!.process.once('error', reject) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Environment probe timed out')), 5000) }),
    ])
    expect(exitCode, stderr).toBe(0)
    return JSON.parse(stdout) as ObservedEnvironment
  } finally {
    clearTimeout(timer)
    if (handle?.process.exitCode === null && handle.process.signalCode === null) await handle.stop(1000)
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

for (const [name, start] of [['IDE', startIdeProcess], ['SDK', startSdkProcess]] as const) {
  test(`${name}启动引擎不会让项目服务继承引擎端口`, async () => {
    expect(await inspectLauncher(start, {})).toEqual({
      enginePort: '12479', engineHost: '127.0.0.1',
      project: { port: null, host: null, selectedPort: 8765, bootstrapMarker: null },
    })
  })

  test(`${name}保留父进程明确设置的项目PORT与HOST`, async () => {
    expect(await inspectLauncher(start, { PORT: '8765', HOST: '0.0.0.0', AETHER_ENGINE_PORT: '12500' })).toEqual({
      enginePort: '12479', engineHost: '127.0.0.1',
      project: { port: '8765', host: '0.0.0.0', selectedPort: 8765, bootstrapMarker: null },
    })
  })

  test(`${name}调用方环境覆盖保留优先级且项目变量不改变监听参数`, async () => {
    expect(await inspectLauncher(start, { PORT: '8765', HOST: 'parent-project-host' }, { PORT: '9000', HOST: 'project-host' })).toEqual({
      enginePort: '12479', engineHost: '127.0.0.1',
      project: { port: '9000', host: 'project-host', selectedPort: 9000, bootstrapMarker: null },
    })
    const explicit = await inspectLauncher(start, {}, { AETHER_ENGINE_PORT: '12480', AETHER_ENGINE_HOST: '::1' })
    expect(explicit.enginePort).toBe('12480')
    expect(explicit.engineHost).toBe('::1')
    expect(explicit.project.port).toBeNull()
    expect(explicit.project.host).toBeNull()
    expect(explicit.project.bootstrapMarker).toBeNull()
  })

  test(`${name}兼容只读取PORT与HOST的旧引擎`, async () => {
    expect(await inspectLauncher(start, {}, {}, legacyScript)).toEqual({ enginePort: '12479', engineHost: '127.0.0.1' })
    expect(await inspectLauncher(start, { PORT: '8765', HOST: 'project-host' }, { PORT: '9000', AETHER_ENGINE_PORT: '12480' }, legacyScript))
      .toEqual({ enginePort: '12480', engineHost: '127.0.0.1' })
  })

  test(`${name}先恢复项目变量再读取env默认值且保留显式空值`, async () => {
    const dotenv = join(fixture, '.env')
    writeFileSync(dotenv, 'PORT=9100\nHOST=dotenv-project-host\n')
    try {
      expect((await inspectLauncher(start, {})).project)
        .toEqual({ port: '9100', host: 'dotenv-project-host', selectedPort: 9100, bootstrapMarker: null })
      expect((await inspectLauncher(start, { PORT: '', HOST: '' })).project)
        .toEqual({ port: '', host: '', selectedPort: 8765, bootstrapMarker: null })
    } finally {
      rmSync(dotenv, { force: true })
    }
  })
}
