/**
 * Ticket 01 cross-platform child-process invocation interface.
 *
 * `child_process.execFileSync` cannot launch the Windows shims `npm.cmd` /
 * `tsc.cmd` directly (CreateProcess refuses .cmd/.bat without a shell). The
 * shared contract is therefore NOT a platform-specific file name: it is a
 * **bare CLI name plus an explicit shell flag**.
 *
 *   - Windows: run the bare `npm` / `tsc` through cmd.exe (`shell: true`),
 *     which resolves the `.cmd` shims via PATH/PATHEXT;
 *   - POSIX: spawn the executable directly with no shell.
 *
 * `scripts/build-dev.mjs` (tsc) and `scripts/build-runtime.mjs` (tsc) both
 * invoke real child processes through `runSync()`, which returns the
 * command + shell semantics directly.
 */
import { execFileSync } from "node:child_process";

/**
 * @typedef {{ command: string, shell: boolean }} CommandInvocation
 *   A bare CLI name and whether it must run through a shell.
 */

/**
 * Describe how to invoke a bare CLI on the given platform. Windows needs the
 * shell to resolve the `.cmd` shims; POSIX executables run directly.
 */
export function commandInvocation(command, platform = process.platform) {
  return { command, shell: platform === "win32" };
}

export function npmInvocation(platform = process.platform) {
  return commandInvocation("npm", platform);
}

export function typescriptInvocation(platform = process.platform) {
  return commandInvocation("tsc", platform);
}

/**
 * Synchronously run an invocation with execFileSync semantics (throws on
 * non-zero exit). Passes caller options through; the shell flag is forced
 * from the invocation so a Windows call always resolves the shims.
 */
export function runSync(invocation, args, options = {}) {
  return execFileSync(invocation.command, args, { ...options, shell: invocation.shell });
}
