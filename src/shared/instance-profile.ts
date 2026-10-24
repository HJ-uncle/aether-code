export interface LaunchInstanceRequest {
  readonly mode: 'default' | 'named' | 'new'
  readonly id: string | null
}

const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Parse the opt-in profile flags without touching Electron or the filesystem. */
export function parseLaunchInstance(
  argv: readonly string[],
  nonce = 'generated'
): LaunchInstanceRequest {
  if (argv.some((value) => value === '--new-instance')) {
    return { mode: 'new', id: `instance-${nonce}` }
  }
  const argument = argv.find((value) => value.startsWith('--aether-instance='))
  if (!argument) return { mode: 'default', id: null }
  const value = argument.slice('--aether-instance='.length).trim()
  if (!INSTANCE_ID.test(value))
    throw new Error('无效的引擎实例标识：只能使用字母、数字、点、下划线或短横线（最多 64 个字符）')
  return { mode: 'named', id: value }
}
