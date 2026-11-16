import { PLUGIN_UI_THEME_TOKENS } from '@shared/plugin-ui'

/** An opaque-origin frame receives only this message bridge, never Electron's preload or origin privileges. */
export function extensionWebviewDocument(html: string, channel: string): string {
  const token = JSON.stringify(channel).replace(/</g, '\\u003c')
  const bridge = `(() => {
    const channel = ${token}, pending = new Map(), listeners = new Set(), eventListeners = new Map(); let sequence = 0;
    // DOM load precedes the opaque frame's first compositor surface. Keep the host's
    // loading cover until a frame has had an opportunity to paint before accepting input.
    addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() => {
      parent.postMessage({ aetherPlugin: 1, channel, event: 'ready' }, '*');
    })), { once: true });
    const call = (method, params = {}, options) => new Promise((resolve, reject) => {
      const streaming = method === 'capability.stream', signal = options?.signal;
      if (streaming && options?.onEvent !== undefined && typeof options.onEvent !== 'function') { reject(new Error('onEvent 需要函数。')); return; }
      if (signal?.aborted) { const error = new Error('插件任务已取消。'); error.name = 'AbortError'; reject(error); return; }
      // The task, explicit cancellation and page lifetime own completion; waiting is not failure.
      const id = String(++sequence);
      const finish = (error, value) => { const entry = pending.get(id); if (!entry) return; pending.delete(id); entry.callbackAbort?.(error || new Error('插件请求已结束。')); signal?.removeEventListener('abort', cancel); if (error) reject(error); else resolve(value); };
      const cancel = () => { parent.postMessage({ aetherPlugin: 1, channel, id, event: 'stream-cancel' }, '*'); const error = new Error('插件任务已取消。'); error.name = 'AbortError'; finish(error); };
      pending.set(id, { finish, cancel, streaming, onEvent: options?.onEvent, queue: Promise.resolve(), ended: false });
      signal?.addEventListener('abort', cancel, { once: true });
      try { parent.postMessage({ aetherPlugin: 1, channel, id, method, params }, '*'); } catch (error) { finish(error); }
    });
    addEventListener('pagehide', () => { for (const entry of [...pending.values()]) entry.streaming ? entry.cancel() : entry.finish(new Error('插件页面已关闭。')); listeners.clear(); eventListeners.clear(); });
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.aetherPlugin !== 1 || event.data.channel !== channel) return;
      if (event.data.event === 'theme') {
        const value = event.data.value;
        if (!value || !['light', 'dark'].includes(value.appearance) || !value.tokens || typeof value.tokens !== 'object') return;
        const root = document.documentElement;
        root.style.colorScheme = value.appearance; root.dataset.appearance = value.appearance;
        for (const name of ${JSON.stringify(PLUGIN_UI_THEME_TOKENS)}) {
          const color = value.tokens[name];
          if (typeof color === 'string' && color.length <= 256 && CSS.supports('color', color)) root.style.setProperty(name, color);
        }
        return;
      }
      if (event.data.event === 'services') { for (const listener of listeners) listener(event.data.value); return; }
      if (event.data.event === 'host-event') { eventListeners.get(event.data.subscription)?.(event.data.value); return; }
      const entry = pending.get(event.data.id); if (!entry) return;
      if (event.data.event === 'stream') {
        if (!entry.streaming || entry.ended) return;
        const data = event.data;
        entry.queue = entry.queue.then(async () => {
          if (!pending.has(data.id)) return;
          await new Promise((resolve, reject) => {
            let completed = false;
            const finishWait = error => { if (completed) return; completed = true; entry.callbackAbort = undefined; error ? reject(error) : resolve(); };
            entry.callbackAbort = error => finishWait(error);
            Promise.resolve().then(() => entry.onEvent?.(data.value)).then(() => finishWait(), finishWait);
          });
          if (pending.has(data.id)) parent.postMessage({ aetherPlugin: 1, channel, id: data.id, event: 'stream-ack', sequence: data.sequence }, '*');
        }).catch(error => { if (!pending.has(data.id)) return; parent.postMessage({ aetherPlugin: 1, channel, id: data.id, event: 'stream-cancel' }, '*'); entry.finish(error); });
        return;
      }
      entry.ended = true;
      const error = event.data.error ? new Error(event.data.error) : undefined, value = event.data.value;
      if (entry.streaming) void entry.queue.then(() => entry.finish(error, value)); else entry.finish(error, value);
    });
    Object.defineProperty(window, 'aetherPlugin', { value: Object.freeze({
      context: () => call('context'), invoke: (tool, args = {}) => call('invoke', { tool, args }),
      navigate: page => call('navigate', { page }),
      download: input => call('download', input),
      services: Object.freeze({ get: () => call('service.get'), start: (id, args = {}) => call('service.start', { id, args }), stop: id => call('service.stop', { id }),
        refresh: id => call('service.status', { id }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } })
    }), writable: false, configurable: false });
    const capability = (name, method, args = {}) => call('capability', { capability: name, method, args });
    const method = (name, action) => (args = {}) => capability(name, action, args);
    const stream = name => (args, options) => call('capability.stream', { capability: name, method: 'stream', args }, options);
    Object.defineProperty(window, '$AE', { value: Object.freeze({
      call: capability,
      context: () => call('context'),
      invoke: (tool, args = {}) => call('invoke', { tool, args }),
      navigate: page => call('navigate', { page }),
      download: input => call('download', input),
      services: window.aetherPlugin.services,
      commands: Object.freeze({ execute: (command, args = {}) => call('commands.execute', { command, args }) }),
      events: Object.freeze({ subscribe: async (event, listener) => { if(typeof listener !== 'function') throw new Error('需要事件回调'); const result = await call('events.subscribe', {event}); eventListeners.set(result.subscription, listener); return result.subscription; }, unsubscribe: async subscription => { eventListeners.delete(subscription); await call('events.unsubscribe', {subscription}); } }),
      ui: Object.freeze({ dialog: input => call('ui.dialog', input), notify: input => call('ui.notify', input),
        clipboard: Object.freeze({ read: () => call('ui.clipboard', {action:'read'}), write: text => call('ui.clipboard', {action:'write',text}) }),
        editor: Object.freeze({ get: () => call('ui.editor.get'), replaceSelection: text => call('ui.editor.replaceSelection', {text}), reveal: input => call('ui.editor.reveal', input) }),
        composer: Object.freeze({ get: () => call('ui.composer.get'), set: text => call('ui.composer.set', {text}), insert: text => call('ui.composer.insert', {text}), submit: () => call('ui.composer.submit') }) }),
      skills: Object.freeze({ list: method('skills.read', 'list'), get: method('skills.read', 'get') }),
      session: Object.freeze({ messages: method('session.read', 'messages') }),
      models: Object.freeze({ list: method('models.read', 'list') }),
      ai: Object.freeze({ run: method('ai.run', 'run'), stream: stream('ai.run') }),
      agents: Object.freeze({ list: method('agents.read', 'list'), tools: method('agents.read', 'tools'), status: method('agents.read', 'status'), run: method('agents.manage', 'run'), stream: stream('agents.manage'), cancel: method('agents.manage', 'cancel') }),
      mcp: Object.freeze({ list: method('mcp.read', 'list'), tools: method('mcp.read', 'tools'), call: method('mcp.invoke', 'call') }),
      knowledge: Object.freeze({ list: method('knowledge.read', 'list'), search: method('knowledge.read', 'search'), get: method('knowledge.read', 'get'), create: method('knowledge.write', 'create'), update: method('knowledge.write', 'update') }),
      workspace: Object.freeze({ list: method('workspace.read', 'list'), read: method('workspace.read', 'read'), write: method('workspace.write', 'write') }),
      settings: Object.freeze({ get: method('settings.read', 'get'), set: method('settings.write', 'set') })
    }), writable: false, configurable: false });
  })();`
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${bridge}</script><style>html{color-scheme:light}body{margin:0;background:var(--bg-surface,Canvas);color:var(--fg,CanvasText);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}:focus-visible{outline:2px solid var(--accent,Highlight);outline-offset:2px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></head><body>${html}</body></html>`
}
