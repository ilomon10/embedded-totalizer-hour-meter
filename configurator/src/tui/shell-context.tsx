// shell-context.tsx: what every screen gets from the shell: the controller and its state, the size of the content
// area, navigation, dialogs, and the key routing. Keys go to the open dialog first, then to the screen, then to
// the global keys (digits, ?, :, r, p, q); a handler returns true when it took the key.
import type { KeyEvent } from '@opentui/core';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { TuiController, UiState } from './controller.ts';
import type { ScreenId } from './model/nav.ts';
import type { Transport } from './model/settings.ts';

export type KeyHandler = (key: KeyEvent) => boolean | void;

export interface ShellApi {
  ctrl: TuiController;
  /** Width and height of the content panel's inside. */
  width: number;
  height: number;
  /** True at 100 columns and more (sidebar layout). */
  wide: boolean;
  go(screen: ScreenId): void;
  /** Open a dialog over the screen (undefined closes it). */
  openDialog(dialog: ReactNode | undefined): void;
  /** How the TUI reaches the device (for the "this cuts your own link" warnings). */
  transport: Transport;
  screenKeys: { current?: KeyHandler };
  dialogKeys: { current?: KeyHandler };
  /** What another screen asked this one to do when it opens (the palette, Overview's h key...). */
  intent: { current?: Intent };
  autoTimeSync: boolean;
  toolVersion: string;
}

/** "Open Counters with the hour meter dialog", "Settings with altDebounceMs selected". */
export interface Intent {
  screen: ScreenId;
  action?: string;
  item?: string;
}

/** Take the intent meant for `screen` (once). */
export function takeIntent(api: ShellApi, screen: ScreenId): Intent | undefined {
  const intent = api.intent.current;
  if (intent?.screen !== screen) return undefined;
  api.intent.current = undefined;
  return intent;
}

export const ShellContext = createContext<ShellApi | undefined>(undefined);

export function useShell(): ShellApi {
  const api = useContext(ShellContext);
  if (!api) throw new Error('useShell outside the shell');
  return api;
}

/** The controller's state; the component draws again when it changes. */
export function useUi(ctrl: TuiController): UiState {
  return useSyncExternalStore(ctrl.subscribe, () => ctrl.snapshot);
}

/** The time, refreshed every `ms` (ages like "updated 0.4 s ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** The current screen's keys (latest handler wins; no re-subscribe on every render). */
export function useScreenKeys(handler: KeyHandler): void {
  const { screenKeys } = useShell();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const route: KeyHandler = (k) => ref.current(k);
    screenKeys.current = route;
    return () => {
      if (screenKeys.current === route) screenKeys.current = undefined;
    };
  }, [screenKeys]);
}

/** An open dialog's keys: it gets every key until it closes. */
export function useDialogKeys(handler: KeyHandler): void {
  const { dialogKeys } = useShell();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const route: KeyHandler = (k) => ref.current(k);
    dialogKeys.current = route;
    return () => {
      if (dialogKeys.current === route) dialogKeys.current = undefined;
    };
  }, [dialogKeys]);
}

/**
 * State that key handlers can read right after setting it. Keys arrive faster than React draws (typing, a pasted
 * value, a held arrow key), so a handler must not read the state of the last render: it reads `ref.current`.
 */
export function useRefState<T>(initial: T | (() => T)): [T, (next: T | ((old: T) => T)) => void, { current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = (next: T | ((old: T) => T)) => {
    ref.current = typeof next === 'function' ? (next as (old: T) => T)(ref.current) : next;
    setValue(ref.current);
  };
  return [value, set, ref];
}

/** A printable key without Ctrl/Alt: the character, else undefined. */
export function charOf(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta || key.option) return undefined;
  const s = key.sequence;
  return s && s.length === 1 && s >= ' ' && s !== '\x7f' ? s : undefined;
}
