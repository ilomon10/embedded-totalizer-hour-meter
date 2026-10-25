// assert.ts: assertion names used by the tests, from node:assert (no third-party deps), and a fake system error.
export {
  deepStrictEqual as assertEquals,
  match as assertMatch,
  ok as assert,
  rejects as assertRejects,
  throws as assertThrows,
} from 'node:assert/strict';

/** An error like a failed system call's (node:fs, node:net): `code` is the errno name. */
export function sysError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
