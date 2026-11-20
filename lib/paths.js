// dsh-appearance-media — data directory resolution.
//
// One rule, three candidates, in this order:
//
//   1. the `dataDir` config field, when it is a non-empty string;
//   2. the `DSH_APPEARANCE_MEDIA_DATA_DIR` environment variable, when it is a
//      non-empty string — the deprecated `DSH_APP_DIR` is read as a fallback
//      inside this candidate, so an existing profile keeps working;
//   3. `~/.dsh/dsh-appearance-media`.
//
// The last one is the default and it is built from `os.homedir()`, never from a
// hard-coded path: a package that carries somebody else's home directory in it
// is a package that breaks the moment it is installed on another machine.
//
// Node built-ins only. This module is loaded by the Host half at module
// evaluation time, and a missing third-party package must never be able to
// take the whole plugin down.

import os from 'node:os'
import path from 'node:path'

/**
 * Environment variable that overrides the default data directory.
 *
 * The name is plugin-specific on purpose: a name as generic as `DSH_APP_DIR`
 * is a name two plugins can both claim and then fight over.
 */
export const DATA_DIR_ENV = 'DSH_APPEARANCE_MEDIA_DATA_DIR'

/**
 * The earlier, too-generic name of that variable.
 *
 * Read as a fallback so a profile that already sets it keeps working. It is
 * deprecated: it is read, never advertised.
 */
export const LEGACY_DATA_DIR_ENV = 'DSH_APP_DIR'

/** The well-known key cosmokit puts on a live config reference. */
const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')

/**
 * Whether a config value is a live reference rather than a plain snapshot.
 *
 * `.volatile()` does not yield the value: it yields a stable reference whose
 * `get()` answers the current immutable snapshot. The reference is identified
 * across ESM/CJS copies of the schema library by this global-registry symbol.
 *
 * A bare `{ get() }` object is accepted too, because the reference handed to
 * `apply` is a host detail and a caller that has only the getter must not be
 * silently handed the wrapper instead of the value.
 *
 * @param value - one config value.
 * @returns true when the value has to be read through `get()`.
 */
function isLive(value) {
  if (typeof value !== 'object' || value === null) return false
  if (VOLATILE_REF in value) return true
  return typeof value.get === 'function'
}

/**
 * Read one applied-config field.
 *
 * The field is a live reference when `Config` declared it volatile — the normal
 * case — and a plain value when the config arrived without schema resolution.
 * An absent field stays absent, leaving the per-field defaulting to its caller.
 *
 * @param config - the applied config, possibly undefined.
 * @param key - field name.
 * @returns the current value, or undefined when the field is absent.
 */
export function readField(config, key) {
  const value = config?.[key]
  if (!isLive(value)) return value
  try {
    return value.get()
  } catch {
    return undefined
  }
}

/**
 * Resolve the absolute data directory of this plugin.
 *
 * @param config - the applied config; its `dataDir` field wins when it is set.
 * @returns an absolute path.
 */
export function dataDir(config) {
  const configured = readField(config, 'dataDir')
  if (typeof configured === 'string' && configured.trim() !== '') {
    return path.resolve(configured.trim())
  }
  for (const name of [DATA_DIR_ENV, LEGACY_DATA_DIR_ENV]) {
    const fromEnv = process.env[name]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      return path.resolve(fromEnv.trim())
    }
  }
  return path.join(os.homedir(), '.dsh', 'dsh-appearance-media')
}

/**
 * The media directory inside a data directory.
 *
 * @param dir - an absolute data directory.
 * @returns the absolute media directory.
 */
export function mediaDir(dir) {
  return path.join(dir, 'media')
}

/**
 * The slot configuration file inside a data directory.
 *
 * ★ THIS EXPORT BELONGS TO TASK 3, ALONE.
 *
 * Task 2's draft also claimed it. Two modules exporting the same name is
 * `SyntaxError: Duplicate export` at module-evaluation time, and that takes
 * the WHOLE plugin down — the routes, the client, the injected row, all of
 * it. One export, one owner.
 *
 * @param dir - an absolute data directory.
 * @returns the absolute configuration path.
 */
export function configPath(dir) {
  return path.join(dir, 'config.json')
}
