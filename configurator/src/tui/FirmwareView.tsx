// FirmwareView.tsx: TUI tab 6. What the device runs, the firmware on the GitHub releases, download and flash.
//
//   ↑↓ select a release   Enter flash it   d download it (cache folder)   c check GitHub again   f flash a file
//
// The work (download, backup, flash, restore) is done by the FirmwareActions that main.tsx passes to App.
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

import { type FirmwareImage, type Note, progressLine } from '../firmware.ts';
import type { FlashProgress } from '../flash.ts';
import { compareVersions, findRelease, type FirmwareRelease, formatFirmware } from '../releases.ts';
import type { Client } from './App.tsx';
import type { Value } from './state.ts';

export interface FirmwareActions {
  /** The firmware on the GitHub releases, newest first. */
  list(): Promise<FirmwareRelease[]>;
  /** A release's image, downloaded into the cache folder and checked against SHA256SUMS. */
  image(release: FirmwareRelease): Promise<FirmwareImage>;
  /** A local image file (refused unless it is an ESP32 image). */
  file(path: string): Promise<FirmwareImage>;
  /**
   * Back up, flash, reconnect, restore. Resolves with the new client, also after a failed flash; without one only
   * if the port did not come back. Only given for the board's USB port: `flashNote` says why it is missing.
   */
  flash?(
    image: FirmwareImage,
    onProgress: (progress: FlashProgress) => void,
    note: (note: Note) => void,
  ): Promise<{ client?: Client; ok: boolean }>;
  flashNote?: string;
}

/** What the text line of the tab asks for. */
export type FirmwarePrompt =
  | { kind: 'path' }
  | { kind: 'confirm'; label: string; release?: FirmwareRelease; image?: FirmwareImage };

export function FirmwareView(
  { fwVersion, releases, releasesNote, cursor, prompt, draft, setDraft, onSubmit, progress, flashNote }: {
    fwVersion: Value | undefined;
    releases?: FirmwareRelease[];
    releasesNote?: string;
    cursor: number;
    prompt?: FirmwarePrompt;
    draft: string;
    setDraft: (s: string) => void;
    onSubmit: (s: string) => void;
    progress?: FlashProgress;
    flashNote?: string;
  },
) {
  const device = formatFirmware(fwVersion);
  const latest = releases && findRelease(releases, 'latest');
  const c = latest && device !== '?' ? compareVersions(latest.version, device) : undefined;
  const verdict = c === undefined ? '' : c > 0 ? 'update available' : c === 0 ? 'up to date' : 'the device is newer';
  return (
    <Box flexDirection='column' borderStyle='single' paddingX={1}>
      <Text bold color='cyan'>Firmware ↑↓ select Enter flash d download c check again f flash a file</Text>
      <Text>
        Device <Text bold>{device}</Text>
      </Text>
      <Text>
        Latest {latest ? `${latest.version} (${latest.tag}, ${latest.date.slice(0, 10)})` : '-'}{' '}
        <Text color={c !== undefined && c > 0 ? 'yellow' : 'green'}>{verdict}</Text>
      </Text>
      {releasesNote ? <Text color='gray'>{releasesNote}</Text> : null}
      <Text></Text>
      {(releases ?? []).map((r, i) => {
        const marks = [
          r === latest ? 'latest' : '',
          r.prerelease ? 'prerelease' : '',
          r.version === device ? 'on the device' : '',
        ].filter(Boolean).join(', ');
        return (
          <Box key={r.version} gap={2}>
            <Text inverse={i === cursor}>{` ${r.version.padEnd(8)}`}</Text>
            <Text>{r.tag.padEnd(16)}</Text>
            <Text color='gray'>{r.date.slice(0, 10)}</Text>
            <Text color='green'>{marks}</Text>
          </Box>
        );
      })}
      <Text></Text>
      {progress ? <Text color='yellow'>{progressLine(progress)}</Text> : null}
      {prompt
        ? (
          <Text>
            {prompt.kind === 'path'
              ? 'image file (merged .bin or firmware.bin)'
              : `type FLASH to write ${prompt.label}`}:{' '}
            <TextInput value={draft} onChange={setDraft} onSubmit={onSubmit} />
          </Text>
        )
        : null}
      <Text color='gray'>
        {flashNote ??
          'Over USB. The counters and settings are backed up first and put back if the new firmware loses them.'}
      </Text>
    </Box>
  );
}
