import { describe, expect, it } from 'vitest';
import { NetClient, type NetWalk, type WebSocketLike } from '../src/net/client';
import type { ServerEvent } from '../src/net/protocol';

/**
 * The page's end of the match (`../src/net/client`), alone: a socket the constructor cannot open, and the death's
 * hand-off to the mover (the launch review's B10 minors).
 */

/** A walk that records what the client drives. */
function recorder(): NetWalk & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setNetTap: (tap) => { calls.push(`tap ${tap ? 'on' : 'off'}`); },
    respawn: (at) => { calls.push(`respawn ${at.join(',')}`); return true; },
    nudge: () => undefined,
    setLocked: (on) => { calls.push(`locked ${on}`); },
    setDead: (on) => { calls.push(`dead ${on}`); },
  };
}

/** A socket the test drives: `server(ev)` delivers an event as the server's text frame. */
function fakeSocket(): WebSocketLike & { server(ev: ServerEvent): void; sent: unknown[] } {
  const s = {
    binaryType: 'blob', readyState: 1, sent: [] as unknown[],
    send(data: string | Uint8Array) { s.sent.push(data); },
    close() { s.readyState = 3; s.onclose?.({ code: 1000, reason: '' }); },
    onopen: null as WebSocketLike['onopen'], onclose: null as WebSocketLike['onclose'],
    onmessage: null as WebSocketLike['onmessage'], onerror: null as WebSocketLike['onerror'],
    server(ev: ServerEvent) { s.onmessage?.({ data: JSON.stringify(ev) }); },
  };
  return s;
}

describe('NetClient: a socket the constructor cannot open (WHATWG WebSocket throws SyntaxError / SecurityError)', () => {
  it('leaves the client closed, the walk free, and never throws out of the constructor', () => {
    const walk = recorder();
    let client: NetClient | null = null;
    expect(() => {
      client = new NetClient({
        url: 'ws://x/ws', map: 'MP1', name: '',
        socket: () => { throw new DOMException('mixed content', 'SecurityError'); },
      }, walk);
    }).not.toThrow();
    const c = client as unknown as NetClient;
    expect(c.state).toBe('closed');                         // NetPage.retry() backs off from 'closed'
    expect(walk.calls).not.toContain('locked true');       // nothing will ever stand the mover: it is not locked
    expect(() => c.send({ type: 'ping', t: 0 })).not.toThrow();
    expect(() => c.close()).not.toThrow();
  });

  it('the page\'s own factory (no opts.socket) is caught the same way', () => {
    const had = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = function Throwing() { throw new SyntaxError('bad scheme'); };
    try {
      const c = new NetClient({ url: 'ftp://x', map: 'MP1', name: '' }, recorder());
      expect(c.state).toBe('closed');
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = had;
    }
  });
});

describe('NetClient: a death holds the mover down (DEATH_LANDING_GETUP_PLACEHOLDER is offline only)', () => {
  it('its own kill marks the walk dead; its own spawn brings it back; another\'s kill does not', () => {
    const walk = recorder(), socket = fakeSocket();
    new NetClient({ url: 'mem', map: 'MP1', name: 'A', socket: () => socket }, walk);
    socket.server({ type: 'welcome', id: 3, version: 0, map: 'MP1', tick: 0, role: 'player', team: 'seals', queue: 0 } as unknown as ServerEvent);
    socket.server({ type: 'kill', killer: 5, victim: 4, weapon: null, how: 'fall', clip: null } as unknown as ServerEvent);
    expect(walk.calls.filter((c) => c.startsWith('dead'))).toEqual([]);
    socket.server({ type: 'kill', killer: null, victim: 3, weapon: null, how: 'fall', clip: null } as unknown as ServerEvent);
    expect(walk.calls.slice(-2)).toEqual(['locked true', 'dead true']);
    socket.server({ type: 'spawn', id: 3, at: [1, 2, 3], yaw: 0, after: 0 });
    const i = walk.calls.indexOf('dead false');
    expect(i).toBeGreaterThan(0);
    expect(walk.calls.indexOf('respawn 1,2,3')).toBeGreaterThan(i);   // cleared before the new mover stands
  });
});
