// platform.ts: the OS name and system-error codes the rest of the tool compares against.

/** 'linux', 'darwin' or 'windows' (not Node's 'win32': the code and the tests use 'windows'). */
export const OS: string = process.platform === 'win32' ? 'windows' : process.platform;

/** The errno name of a failed system call or socket ('ENOENT', 'EACCES', 'EBUSY', 'ECONNREFUSED', ...). */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}
