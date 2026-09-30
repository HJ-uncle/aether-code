import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** Seed writable skills without replacing user edits; a packaged runtime remains read-only. */
function copyMissing(source: string, target: string): void {
  if (lstatSync(source).isSymbolicLink()) throw new Error('Bundled skills must not contain symbolic links')
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Writable skills must not contain symbolic links')
  if (lstatSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const child of readdirSync(source)) copyMissing(join(source, child), join(target, child))
  } else if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    try { copyFileSync(source, target, constants.COPYFILE_EXCL) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
}

export function preparePackagedRuntime(root: string, userData: string, inheritedPath = ''): { cwd: string; env: Record<string, string> } {
  const state = join(userData, 'engine', 'state')
  const skills = join(userData, 'engine', 'skills')
  const seed = join(root, 'SKILLs')
  if (!existsSync(seed)) throw new Error('安装包缺少内置技能资源，请重新安装配套版本')
  mkdirSync(state, { recursive: true })
  copyMissing(seed, skills)
  return { cwd: state, env: {
    NODE_ENV: 'production',
    PATH: join(root, 'runtime') + delimiter + inheritedPath,
    WORKSPACE_ROOT: join(state, 'workspace'),
    QA_LOG_DIR: join(state, 'logs', 'qa'),
    AETHER_GLOBAL_DIR: join(userData, 'engine', 'config'),
    MCP_CONFIG_PATH: join(userData, 'engine', 'config', 'mcp.json'),
    SKILLS_ROOT: skills,
  } }
}
