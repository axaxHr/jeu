/**
 * WebSocket connection with automatic reconnection (exponential backoff).
 * Close code 4000 means "replaced by another tab": do not fight it.
 */
export class Connection {
  /**
   * @param {string} url ws:// or wss:// URL.
   * @param {{onOpen:() => void, onMessage:(msg:object) => void, onClose:(ev:CloseEvent, final:boolean) => void}} handlers
   */
  constructor(url, handlers) {
    this.url = url;
    this.h = handlers;
    this.ws = null;
    this.stopped = false;
    this.retry = 0;
    this.timer = 0;
  }

  open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.h.onOpen(); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && typeof msg.t === 'string') this.h.onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.ws === ws) this.ws = null;
      if (e.code === 4000) this.stopped = true;
      this.h.onClose(e, this.stopped);
      if (!this.stopped) {
        const delay = Math.min(10_000, 1000 * 2 ** this.retry++);
        this.timer = setTimeout(() => this.open(), delay);
      }
    };
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) this.ws.close();
  }
}

/** The game socket lives next to the page: …/index.html → …/ws (works behind a sub-path proxy). */
export function socketUrl(loc = window.location) {
  const url = new URL('ws', loc.href);
  url.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';
  return url.toString();
}
