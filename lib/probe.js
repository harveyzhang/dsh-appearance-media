// dsh-appearance-media — the idle probe.
//
// ★ WHAT IT ANSWERS, AND WHAT IT DOES NOT.
//
//   { ok, idleMs, status, reason }
//
//   * `status` is one of `ok` / `starting` / `unavailable`;
//   * `idleMs` is a NUMBER only when the status is `ok` — otherwise it is
//     `null`, and that is load-bearing.
//
// ★ WHY THE THREE STATES MAY NOT BE COLLAPSED.
//
//   `starting` means "ask again shortly"; `unavailable` means "never going to
//   work here, use the other half of the trigger". A caller that cannot tell
//   them apart either abandons a slow start or polls a permanent failure
//   forever. And the shape that must never happen is a failure flattened into
//   `idleMs: 0` — zero IS "the machine is being used right now", so a probe
//   that failed would look like a busy machine and the screensaver would never
//   appear (or, worse, the failure would be read as "idle for 0 ms" and the
//   screen would come up the instant the machine was touched).
//
// ★ DARWIN, AND HOW THE READING IS TAKEN.
//
//   `/usr/sbin/ioreg -n IOHIDSystem -d 4` answers with a property tree that
//   carries `"HIDIdleTime" = <nanoseconds>`. Dividing by 1e6 gives the
//   milliseconds the screensaver's threshold is measured in.
//
// ★ EVERY READ SPAWNS. THERE IS NO RESIDENT CHILD.
//
//   The reading costs about 3.6 ms, and the screensaver's threshold is
//   measured in minutes — so a spawn per read is invisible, and it buys two
//   things a resident child cannot:
//
//   * there is NO PROCESS TO OUTLIVE THE HOST. A resident probe that was
//     started by an earlier Host keeps running after that Host is gone, holds
//     tens of megabytes, and reports a parent pid that no longer exists;
//   * there is nothing to dispose, so a plugin that is unloaded leaves
//     nothing behind.
//
// ★ THE `-c` VARIANT IS NOT USED.
//
//   `ioreg -c IOHIDSystem` matches by CLASS rather than by NAME and prints
//   every matching object: about 30 ms and about 503 KB, against 3.6 ms and a
//   few kilobytes for the `-n` form. That is eight times the time and
//   twenty-five times the bytes, for the same number.
//
// ★ THE PLATFORM IS CHECKED FIRST.
//
//   `IOHIDSystem` is a macOS thing. On any other platform the probe answers
//   `unavailable` without spawning anything at all — and the screensaver
//   falls back to its other half (how long the window has been out of focus).

import { execFile } from 'node:child_process'

/** The binary that carries the counter. */
export const IOREG_PATH = '/usr/sbin/ioreg'

/**
 * The arguments.
 *
 * ★ `-n IOHIDSystem` (BY NAME) and `-d 4` (FOUR LEVELS DEEP).
 *
 * The `-c` variant is deliberately absent — see the note at the top of this
 * file.
 */
export const IOREG_ARGS = ['-n', 'IOHIDSystem', '-d', '4']

/** The property that carries the idle time, in nanoseconds. */
export const IDLE_KEY = 'HIDIdleTime'

/** The reading succeeded. */
export const STATUS_OK = 'ok'

/** The reading has not arrived yet — ask again shortly. */
export const STATUS_STARTING = 'starting'

/** The reading will never arrive here. */
export const STATUS_UNAVAILABLE = 'unavailable'

/** How long a single read may take, in milliseconds. */
const READ_TIMEOUT_MS = 2000

/**
 * Pull the idle time out of an `ioreg` answer.
 *
 * @param {string} text - the command's standard output.
 * @returns {number|null} the idle time in milliseconds, or null when the
 *   answer carries no counter.
 */
export function parseIdleMs(text) {
  if (typeof text !== 'string' || text === '') return null
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text)
  if (match === null) return null
  const nanoseconds = Number(match[1])
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) return null
  return Math.round(nanoseconds / 1e6)
}

/**
 * Run the command once, with its output captured.
 *
 * ★ NO RESIDENT CHILD. One spawn, one answer, one exit.
 *
 * @param {string} bin - the binary.
 * @param {string[]} args - the arguments.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number|null, timedOut: boolean, errno: string|null}>}
 */
function defaultRun(bin, args) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          // ★ THE TIMEOUT IS A TRANSIENT FAILURE AND THE MISSING BINARY IS A
          // PERMANENT ONE. A machine that was busy for two seconds can answer
          // on the next read; a machine without `ioreg` never will.
          const timedOut = error.killed === true || error.signal === 'SIGTERM'
          const code = error.code
          const errno = typeof code === 'string' ? code : null
          resolve({
            ok: false,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
            exitCode: typeof code === 'number' ? code : null,
            timedOut,
            errno,
          })
          return
        }
        resolve({
          ok: true,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode: 0,
          timedOut: false,
          errno: null,
        })
      },
    )
  })
}

/**
 * Build a probe.
 *
 * The runner is injectable so the offline suite can drive every branch —
 * including the two failures — without spawning anything.
 *
 * @param {{run?: Function, platform?: string}} options - the seams.
 * @returns {{read: () => Promise<{ok: boolean, idleMs: number|null, status: string, reason: string}>}}
 */
export function createProbe({ run, platform } = {}) {
  const runner = typeof run === 'function' ? run : defaultRun
  const currentPlatform = typeof platform === 'string'
    ? platform
    : (typeof process !== 'undefined' && process.platform ? process.platform : 'unknown')

  /**
   * One answer that is not a reading.
   *
   * @param {string} status - `starting` or `unavailable`.
   * @param {string} reason - why.
   * @returns {{ok: boolean, idleMs: null, status: string, reason: string}}
   */
  function failure(status, reason) {
    return { ok: false, idleMs: null, status, reason }
  }

  return {
    /**
     * Read the idle time, now.
     *
     * @returns {Promise<{ok: boolean, idleMs: number|null, status: string, reason: string}>}
     */
    async read() {
      // ★ THE PLATFORM IS CHECKED BEFORE ANYTHING IS SPAWNED.
      if (currentPlatform !== 'darwin') return failure(STATUS_UNAVAILABLE, 'not-darwin')
      let outcome = null
      try {
        outcome = await runner(IOREG_PATH, IOREG_ARGS)
      } catch (error) {
        return failure(STATUS_STARTING, 'spawn-error')
      }
      if (outcome === null || typeof outcome !== 'object') {
        return failure(STATUS_STARTING, 'no-answer')
      }
      if (outcome.errno === 'ENOENT') return failure(STATUS_UNAVAILABLE, 'ioreg-missing')
      if (outcome.timedOut === true) return failure(STATUS_STARTING, 'timeout')
      if (outcome.ok !== true) {
        // A non-zero exit means the command ran and refused. That is permanent:
        // the same command will refuse again.
        if (typeof outcome.exitCode === 'number') return failure(STATUS_UNAVAILABLE, 'ioreg-failed')
        return failure(STATUS_STARTING, 'spawn-error')
      }
      const idleMs = parseIdleMs(outcome.stdout)
      // ★ NO COUNTER IN THE ANSWER IS A PERMANENT FAILURE, NOT A ZERO.
      if (idleMs === null) return failure(STATUS_UNAVAILABLE, 'no-idle-counter')
      return { ok: true, idleMs, status: STATUS_OK, reason: 'ok' }
    },
  }
}

/** The probe this build uses. */
export const probe = createProbe()

/**
 * Read the idle time, now.
 *
 * @returns {Promise<{ok: boolean, idleMs: number|null, status: string, reason: string}>}
 */
export function readIdle() {
  return probe.read()
}
