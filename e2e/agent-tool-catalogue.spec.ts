import { expect, test } from '@playwright/test'
import { canonicalAgentToolName, visibleAgentToolCatalogue } from '../src/renderer/src/core/engine/agent-catalogue'

test('Agent management exposes one capability per action, even with an older catalogue', () => {
  const names = ['agent_list', 'agent_get', 'agent_create', 'agent_do_create', 'agent_update', 'agent_do_update', 'agent_delete', 'agent_do_delete']
  const result = visibleAgentToolCatalogue([...names, 'agent_create', 'mcp_custom_create'].map(name => ({ name })))
  expect(result.map(tool => tool.name)).toEqual(['agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete', 'mcp_custom_create'])
})

test('previously selected execution aliases map to the canonical permission without losing the selection', () => {
  expect([...new Set(['agent_do_create', 'agent_create', 'agent_do_update', 'read_file'].map(canonicalAgentToolName))])
    .toEqual(['agent_create', 'agent_update', 'read_file'])
})
