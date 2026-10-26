import { expect, test } from '@playwright/test'
import { getRunningWorkTasks } from '../src/renderer/src/contrib/work/work-run-list'
import type { WorkTask } from '../src/renderer/src/contrib/work/work-state'

function task(
  id: string,
  status: WorkTask['status'],
  updatedAt: number,
  archived = false,
  runStartedAt?: number
): WorkTask {
  return {
    id,
    title: id,
    draft: '',
    status,
    createdAt: 1,
    updatedAt,
    ...(runStartedAt === undefined ? {} : { runStartedAt }),
    workspacePath: null,
    modelId: '',
    attachments: [],
    sources: [],
    archived
  }
}

test.describe('Work 运行列表数据', () => {
  test('只显示活动运行/等待任务，按开始顺序稳定排列并把运行中任务排在等待任务前', () => {
    const result = getRunningWorkTasks([
      task('done', 'done', 99),
      task('waiting-old', 'waiting', 10),
      task('running-old', 'running', 30, false, 10),
      task('archived', 'running', 100, true, 1),
      task('running-new', 'running', 20, false, 20)
    ])

    expect(result.map((item) => item.id)).toEqual(['running-old', 'running-new', 'waiting-old'])
  })
})
