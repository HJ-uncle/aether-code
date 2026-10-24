/**
 * Read only the configured model connection for the current real-model UI test.
 * The return value contains a provider credential: keep it in memory, send it
 * only to the isolated engine's model API, and never serialize it into evidence.
 * No user accounts, sessions, history, or source database rows are modified.
 */
import { createDecipheriv } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const defaultDatabase = fileURLToPath(new URL('../../ai-agent-engine/data/agent.db', import.meta.url))
// Matches the engine's development fallback. Production sources must pass their
// preserved key explicitly; a failed authentication never falls back silently.
const developmentKey = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

export function readConfiguredModel({
  database = defaultDatabase,
  modelId = 'deepseek-v4.1-flash',
  encryptionKey = process.env.ENCRYPTION_KEY || developmentKey
} = {}) {
  let db
  let key
  let plaintext
  let final
  try {
    if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error()
    key = Buffer.from(encryptionKey, 'hex')
    db = new DatabaseSync(database, { readOnly: true })
    db.exec('PRAGMA query_only=ON')
    const row = db.prepare(`SELECT provider,model_id,api_key,base_url,display_name,version,capabilities
      FROM models WHERE tenant_id='default' AND model_id=? AND is_enabled=1 AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1`).get(modelId)
    if (!row || typeof row.api_key !== 'string') throw new Error()
    const parts = row.api_key.split(':')
    if (parts.length !== 3 || !/^[a-f0-9]{24}$/i.test(parts[0]) || !/^[a-f0-9]{32}$/i.test(parts[1]) || !/^(?:[a-f0-9]{2})+$/i.test(parts[2])) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'))
    decipher.setAuthTag(Buffer.from(parts[1], 'hex'))
    plaintext = decipher.update(Buffer.from(parts[2], 'hex'))
    final = decipher.final()
    const apiKey = plaintext.toString('utf8') + final.toString('utf8')
    if (apiKey.length < 16) throw new Error()
    const endpoint = new URL(String(row.base_url))
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error()
    const capabilityOverrides = row.capabilities ? JSON.parse(String(row.capabilities)) : null
    if (capabilityOverrides !== null && (typeof capabilityOverrides !== 'object' || Array.isArray(capabilityOverrides))) throw new Error()
    // POST /models accepts this object. It creates a disabled model; the test
    // must subsequently PUT {isEnabled:true} and perform /models/:id/test.
    return {
      provider: String(row.provider),
      modelId: String(row.model_id),
      apiKey,
      baseUrl: String(row.base_url),
      ...(row.display_name ? { displayName: String(row.display_name) } : {}),
      ...(row.version ? { version: String(row.version) } : {}),
      capabilityOverrides
    }
  } catch {
    // SQLite/crypto/provider errors can contain SQL values and endpoint details.
    throw new Error('Cannot read an enabled real-model connection from the source database with the preserved encryption key; source data was not modified.')
  } finally {
    plaintext?.fill(0)
    final?.fill(0)
    key?.fill(0)
    db?.close()
  }
}
