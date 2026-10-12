// useSimulator.ts: the page's only connection to the simulator. A WebSocket to
// /api/ws that delivers state (5 per second) and frame-log lines, and takes the
// control messages from the panels. Reconnects on its own.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClientMessage, LogEntry, ServerMessage, SimState, TrackPoint } from '../../src/web/messages.ts';

const MAX_LOG = 1000;
const RETRY_MS = 1000;
const MAX_TRACK = 7200; // an hour at 2 points per second, like the simulator keeps

export type Link = 'connecting' | 'open' | 'closed';

export interface Simulator {
  link: Link;
  state: SimState | null;
  log: LogEntry[];
  /** Truth and estimate positions of the current vehicle, oldest first. */
  track: TrackPoint[];
  send(msg: ClientMessage): void;
  clearLog(): void;
}

export function useSimulator(): Simulator {
  const [link, setLink] = useState<Link>('connecting');
  const [state, setState] = useState<SimState | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [track, setTrack] = useState<TrackPoint[]>([]);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      socket.current = ws;
      setLink('connecting');
      ws.onopen = () => setLink('open');
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === 'state') setState(msg.state);
        else if (msg.type === 'log') setLog((old) => [...old, ...msg.entries].slice(-MAX_LOG));
        else setTrack((old) => (msg.reset ? msg.points : [...old, ...msg.points]).slice(-MAX_TRACK));
      };
      ws.onclose = () => {
        setLink('closed');
        if (!closed) retry = setTimeout(connect, RETRY_MS);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(msg));
  }, []);
  const clearLog = useCallback(() => setLog([]), []);

  return { link, state, log, track, send, clearLog };
}
