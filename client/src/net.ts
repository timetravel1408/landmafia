// Server endpoints + WebSocket connection. Nothing is persisted client-side.
import type { ClientMsg, ServerMsg } from '@landmafia/shared';

const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? '';
export const HTTP_BASE = configured || location.origin;
export const WS_URL = HTTP_BASE.replace(/^http/, 'ws') + '/ws';

export async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(HTTP_BASE + path, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export class Connection {
  private ws: WebSocket | null = null;
  private handlers: ((m: ServerMsg) => void)[] = [];
  onClose: ((ev: CloseEvent) => void) | null = null;

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the game server.'));
      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        for (const h of this.handlers) h(msg);
      };
      ws.onclose = (ev) => {
        if (this.ws === ws) this.ws = null;
        this.onClose?.(ev);
      };
    });
  }

  on(h: (m: ServerMsg) => void) {
    this.handlers.push(h);
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws?.close(1000, 'bye');
    this.ws = null;
  }
}
