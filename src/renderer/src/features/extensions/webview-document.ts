import { PLUGIN_UI_THEME_TOKENS } from '@shared/plugin-ui'

/** An opaque-origin frame receives only this message bridge, never Electron's preload or origin privileges. */
export function extensionWebviewDocument(html: string, channel: string): string {
  const token = JSON.stringify(channel).replace(/</g, '\\u003c')
  const bridge = `(() => {
    const channel = ${token}, pending = new Map(), listeners = new Set(); let sequence = 0;
    // DOM load precedes the opaque frame's first compositor surface. Keep the host's
    // loading cover until a frame has had an opportunity to paint before accepting input.
    addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() => {
      parent.postMessage({ aetherPlugin: 1, channel, event: 'ready' }, '*');
    })), { once: true });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = String(++sequence), timeout = setTimeout(() => { pending.delete(id); reject(new Error('插件请求超时')); }, 310000);
      pending.set(id, { resolve, reject, timeout }); parent.postMessage({ aetherPlugin: 1, channel, id, method, params }, '*');
    });
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
      const entry = pending.get(event.data.id); if (!entry) return; pending.delete(event.data.id); clearTimeout(entry.timeout);
      if (event.data.error) entry.reject(new Error(event.data.error)); else entry.resolve(event.data.value);
    });
    Object.defineProperty(window, 'aetherPlugin', { value: Object.freeze({
      context: () => call('context'), invoke: (tool, args = {}) => call('invoke', { tool, args }),
      navigate: page => call('navigate', { page }),
      services: Object.freeze({ get: () => call('service.get'), start: (id, args = {}) => call('service.start', { id, args }), stop: id => call('service.stop', { id }),
        refresh: id => call('service.status', { id }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } })
    }), writable: false, configurable: false });
  })();`
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${bridge}</script><style>html{color-scheme:light}body{margin:0;background:var(--bg-surface,Canvas);color:var(--fg,CanvasText);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}:focus-visible{outline:2px solid var(--accent,Highlight);outline-offset:2px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></head><body>${html}</body></html>`
}
