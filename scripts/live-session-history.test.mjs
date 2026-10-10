import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertRenderedUsers, latestRealUser, readSessionArchive } from './live-session-history.mjs'

const sessionId = 'selected-session'
const user = (id, turnId) => ({ id, role: 'user', conversationId: turnId, sessionId, content: '真实消息 ' + id })
const first = user('first-user', 'first-turn'), latest = user('latest-user', 'latest-turn')
const snapshot = { sessionId, historyCompacted: true, history: [{ id: 'summary', role: 'system', metadata: { isCompactSummary: true }, content: '真实消息 latest-user' }, { id: 'recent-tool', role: 'tool', content: 'latest-user' }], run: { userMessageId: latest.id, turnId: latest.conversationId } }

function responder(rows, mutate = x => x) {
 return async (path, query) => {
   assert.equal(path, '/conversation/archive'); assert.equal(query.sessionId, sessionId)
   const total = rows.length, totalPages = Math.ceil(total / query.pageSize)
   return mutate({ ok: true, data: rows.slice((query.current - 1) * query.pageSize, query.current * query.pageSize), pagination: { current: query.current, pageSize: query.pageSize, total, totalPages }, metadata: { archiveMessageCount: total } }, query)
 }
}

test('compacted snapshot with no user resolves the latest persisted user from the final archive page', async () => {
 const rows = [first, { id: 'assistant', role: 'assistant' }, latest, { ...user('sidechain-user', 'side-turn'), isSidechain: true }]
 const archive = await readSessionArchive(responder(rows), sessionId, { pageSize: 2 })
 assert.equal(archive.pages.length, 2); assert.deepEqual(archive.rows, rows)
 assert.equal(latestRealUser(snapshot, archive.rows), latest)
 assert.throws(() => latestRealUser(snapshot), /latest real user/)
})

test('ordinary snapshot retains exact root user identity and turn', () => {
 assert.equal(latestRealUser({ ...snapshot, historyCompacted: false, history: [first, latest] }), latest)
 assert.throws(() => latestRealUser(snapshot, [first]), /exactly the selected session/)
 assert.throws(() => latestRealUser(snapshot, [{ ...latest, conversationId: 'foreign-turn' }]), /selected latest turn/)
})

test('archive paging rejects repeated IDs, foreign sessions and incomplete totals', async () => {
 await assert.rejects(readSessionArchive(responder([first, first]), sessionId, { pageSize: 1 }), /duplicate message IDs/)
 await assert.rejects(readSessionArchive(responder([{ ...latest, sessionId: 'foreign-session' }]), sessionId), /selected session/)
 await assert.rejects(readSessionArchive(responder([first, latest], out => ({ ...out, data: out.data.slice(0, 1) })), sessionId), /all selected session archive rows/)
})

test('UI recovery rejects summary-only display, duplicate rows, foreign users, missing pages and reordered users', () => {
 assert.throws(() => assertRenderedUsers([], [first, latest], { complete: true }), /exact persisted order/)
 assert.throws(() => assertRenderedUsers([latest.id, latest.id], [first, latest]), /duplicated/)
 assert.throws(() => assertRenderedUsers(['foreign-user'], [first, latest]), /exact selected session/)
 assertRenderedUsers([latest.id], [first, latest])
 assert.throws(() => assertRenderedUsers([latest.id, first.id], [first, latest], { complete: true }), /exact persisted order/)
 assertRenderedUsers([first.id, latest.id], [first, latest], { complete: true })
})


test('archive acceptance has no 100-page or 20000-row ceiling and preserves every user identity', async () => {
 const rows = Array.from({ length: 20201 }, (_, index) => user('long-user-' + index, 'long-turn-' + index))
 const archive = await readSessionArchive(responder(rows), sessionId)
 assert.equal(archive.pages.length, 102)
 assert.deepEqual(archive.rows.map(row => row.id), rows.map(row => row.id))
 assertRenderedUsers(archive.rows.map(row => row.id), rows, { complete: true })
})
