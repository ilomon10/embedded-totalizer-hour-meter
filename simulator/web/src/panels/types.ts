// types.ts: what every panel receives.
import type { ClientMessage, SimState } from '../../../src/web/messages.ts';

export interface PanelProps {
  state: SimState;
  send: (msg: ClientMessage) => void;
}
