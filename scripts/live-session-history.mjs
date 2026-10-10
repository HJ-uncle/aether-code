import assert from 'node:assert/strict'

// A snapshot is a model projection. Read every archive page before deciding which user is latest.
export async function readSessionArchive(requestResult, sessionId, { pageSize = 200 } = {}) {
 const rows = [], pages = [], ids = new Set()
 let total, totalPages, revision
 for (let current = 1; ; current++) {
   const out = await requestResult('/conversation/archive', { sessionId, current, pageSize })
   assert.equal(out.ok, true, 'selected session archive request succeeds')
   assert.ok(Array.isArray(out.data), 'selected session archive returns message rows')
   const pagination = out.pagination
   assert.ok(pagination, 'explicit archive request must be paginated')
   assert.equal(pagination.current, current, 'archive page cursor belongs to this request')
   assert.equal(pagination.pageSize, pageSize, 'archive page size belongs to this request')
   assert.equal(pagination.total, out.metadata?.archiveMessageCount, 'archive total agrees with its metadata')
   assert.equal(pagination.totalPages, Math.ceil(pagination.total / pageSize), 'archive page count covers all rows')
   assert.ok(Number.isSafeInteger(pagination.total) && pagination.total >= 0, 'archive total is a finite non-negative integer')
   if (total === undefined) { total = pagination.total; totalPages = pagination.totalPages; revision = out.metadata?.archiveRevision }
   assert.equal(out.metadata?.archiveRevision, revision, 'terminal archive revision stays stable across pages')
   assert.equal(pagination.total, total, 'terminal archive stays stable across pages')
   assert.equal(pagination.totalPages, totalPages, 'terminal archive page count stays stable')
   for (const row of out.data) {
     assert.ok(typeof row.id === 'string' && row.id, 'archive message has a persisted identity')
     assert.equal(ids.has(row.id), false, 'archive pages contain no duplicate message IDs')
     if (row.sessionId !== undefined) assert.equal(row.sessionId, sessionId, 'archive row belongs to selected session')
     ids.add(row.id); rows.push(row)
   }
   pages.push({ current, rows: out.data.length, total, totalPages })
   if (current >= totalPages) {
     assert.equal(rows.length, total, 'all selected session archive rows were recovered')
     return { rows, pages }
   }
 }
}

export function latestRealUser(snapshot, archiveRows) {
 const rows = archiveRows ?? snapshot.history
 const latest = rows.filter(row => row.role === 'user' && !row.isSidechain).at(-1)
 assert.ok(latest, 'latest real user message exists in selected session history')
 assert.ok(typeof latest.id === 'string' && latest.id, 'latest user has a persisted identity')
 if (snapshot.run?.userMessageId) {
   assert.equal(latest.id, snapshot.run.userMessageId, 'latest user is exactly the selected session latest root user')
   assert.equal(latest.conversationId ?? latest.metadata?.turnId, snapshot.run.turnId, 'latest user belongs to selected latest turn')
 }
 return latest
}

export function assertRenderedUsers(renderedIds, archiveUsers, { complete = false } = {}) {
 assert.equal(new Set(renderedIds).size, renderedIds.length, 'restored user message IDs are not duplicated')
 const expectedIds = archiveUsers.map(row => row.id)
 assert.equal(new Set(expectedIds).size, expectedIds.length, 'archive user IDs are not duplicated')
 const expected = new Set(expectedIds)
 for (const id of renderedIds) assert.ok(expected.has(id), 'rendered user belongs to the exact selected session archive')
 if (complete) assert.deepEqual(renderedIds, expectedIds, 'all selected session archive users retain exact persisted order')
}
