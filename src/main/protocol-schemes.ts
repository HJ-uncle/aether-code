import { app, protocol } from 'electron'
import { PLUGIN_UI_SCHEME } from '../shared/plugin-ui'

// Electron permits this registration once, before ready. Keep browser-file and plugin origins together.
if (!app.isReady()) protocol.registerSchemesAsPrivileged([
  { scheme: 'aether-local', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: PLUGIN_UI_SCHEME, privileges: { standard: true, secure: true } },
])
