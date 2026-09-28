/**
 * SSH 私钥口令装载（主进程）
 *
 * 移植自 wuzu-client 的 sshAgent。背景：ssh 读 passphrase 直读 /dev/tty，
 * GUI 应用没有 tty，远程操作会挂到超时且 stderr 为空。
 * 解法：写一个 SSH_ASKPASS 脚本把口令经环境变量传给子进程，
 * 用 ssh-add 把私钥装进 ssh-agent，之后的远程操作免口令。
 *
 * 安全约束：口令只经 env 传给 ssh-add 子进程，不落盘、不打日志。
 * Windows 下不支持（ssh-add 走 Pageant/ssh-agent 服务的形态差异太大），直接返回失败文案。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { GitResult } from '../../shared/git-types'

/** askpass 脚本：ssh 执行它，把 stdout 首行当作口令 */
const ASKPASS_SCRIPT = '#!/bin/sh\necho "$AETHER_SSH_PASSPHRASE"\n'

/** 常见私钥文件名（按优先级排列，第一个装载成功即返回） */
const KEY_BASENAMES = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_ed25519_sk', 'id_ecdsa_sk', 'id_dsa']

function homeDir(): string {
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
}

/** 用户 ~/.ssh 下实际存在的私钥 */
function privateKeys(): string[] {
  const home = homeDir()
  if (!home) return []
  return KEY_BASENAMES.map((name) => path.join(home, '.ssh', name)).filter((p) => existsSync(p))
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 15_000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, env }, (error, stdout, stderr) => {
      if (error) {
        const err = error as Error & { stderr?: string }
        err.stderr = stderr ?? ''
        reject(err)
        return
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/**
 * 用口令把本地 SSH 私钥装载进 ssh-agent。
 *
 * 逐个尝试存在的私钥，第一个成功即返回；全部失败时区分「口令错误」与其它原因。
 */
export async function addSshKeyToAgent(passphrase: string): Promise<GitResult> {
  if (process.platform === 'win32') {
    return { success: false, error: 'Windows 下暂不支持自动加载 SSH 私钥，请先在终端执行 ssh-add。' }
  }
  if (!process.env['SSH_AUTH_SOCK']) {
    return {
      success: false,
      error: '未检测到可用的 ssh-agent。请先在终端执行 eval "$(ssh-agent -s)" 后重启应用。'
    }
  }
  const keys = privateKeys()
  if (keys.length === 0) {
    return { success: false, error: '未找到本地 SSH 私钥（~/.ssh/id_ed25519 等）。' }
  }
  if (!passphrase) {
    return { success: false, error: '请输入 SSH 私钥口令。' }
  }

  // askpass 脚本放临时目录，用后即焚
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-askpass-'))
  try {
    const script = path.join(dir, 'askpass.sh')
    await writeFile(script, ASKPASS_SCRIPT, 'utf8')
    await chmod(script, 0o700)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SSH_ASKPASS: script,
      SSH_ASKPASS_REQUIRE: 'force',
      // 兼容旧版 OpenSSH：没有 DISPLAY 时忽略 SSH_ASKPASS
      DISPLAY: process.env['DISPLAY'] || ':0',
      AETHER_SSH_PASSPHRASE: passphrase
    }
    // macOS：--apple-use-keychain 把口令写进系统钥匙串，之后重启也免输
    const extraArgs = process.platform === 'darwin' ? ['--apple-use-keychain'] : []

    let sawBadPassphrase = false
    for (const key of keys) {
      try {
        await run('ssh-add', [...extraArgs, key], env)
        return { success: true }
      } catch (error) {
        const stderr = String((error as { stderr?: string })?.stderr ?? '')
        if (/bad passphrase|incorrect/i.test(stderr)) sawBadPassphrase = true
      }
    }
    if (sawBadPassphrase) {
      return {
        success: false,
        error: '口令不正确：请确认输入的是 SSH 私钥口令（不是账号登录密码）。'
      }
    }
    return { success: false, error: 'SSH 私钥加载失败，请检查密钥文件是否完整。' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
