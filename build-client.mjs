#!/usr/bin/env node
// dsh-appearance-media — client bundle build.
//
// The browser half ships as TWO files: `src/client.js` (readable source) and
// `lib/client.js` (the same text wrapped in the host's module-loader shell).
// The shell is what makes the file loadable as a dynamic bundle: it hands the
// factory a `require` bound to the baseline module table, so `require('react')`
// resolves without this package declaring anything.
//
// This script exists so the pairing cannot drift by hand. It:
//
//   1. reads `src/client.js`,
//   2. refuses to proceed if that file still contains ESM syntax — the shell
//      supplies `require`, and a leftover `import`/`export` would be a syntax
//      error inside the factory, i.e. a bundle that fails at load on the
//      settings page and nowhere earlier,
//   3. wraps the source and writes `lib/client.js`,
//   4. re-reads the output and syntax-checks it, so a broken artifact cannot
//      be left on disk for the next reload to discover.
//
// The syntax check runs `node --check` with `stdio: 'inherit'`. A PIPED child
// is refused by the agent sandbox (EPERM), so the output is never captured:
// it goes straight to the terminal.
//
// Run: node build-client.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('./src/client.js', import.meta.url))
const TARGET = fileURLToPath(new URL('./lib/client.js', import.meta.url))

const HEAD = 'window.__ModuleLoader__.load({ id: "dsh-appearance-media", factory: (require) => {\n'
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const TAIL = '\nreturn module.exports; } });\n'

/** The only module the browser half is allowed to ask for. */
const ALLOWED_REQUIRE = "require('react')"

const source = readFileSync(SOURCE, 'utf8')

// ESM syntax at the start of a line. `exports.apply = apply` does not match:
// the pattern needs whitespace after the keyword, and `exports.` has a dot.
const esm = source.match(/^[ \t]*(?:import|export)[ \t]+.*$/gm)
if (esm !== null) {
  console.error('src/client.js still contains ESM syntax, which the CJS factory cannot take:')
  for (const line of esm) console.error('  ' + line.trim())
  process.exit(1)
}

const requires = source.match(/require\(\s*['"][^'"]+['"]\s*\)/g) ?? []
const foreign = requires.filter((call) => call !== ALLOWED_REQUIRE)
if (foreign.length > 0) {
  console.error('src/client.js requires more than react:')
  for (const call of foreign) console.error('  ' + call)
  process.exit(1)
}

writeFileSync(TARGET, HEAD + source + TAIL)

// Verify the RESULT, not the intention: `node --check` parses the file exactly
// as the browser will, so a shell that was assembled wrong fails here rather
// than on the settings page.
const check = spawnSync(process.execPath, ['--check', TARGET], { stdio: 'inherit' })
if (check.error !== undefined && check.error !== null) {
  console.error('lib/client.js could not be syntax-checked: ' + String(check.error))
  process.exit(1)
}
if (check.status !== 0) {
  console.error('lib/client.js failed the syntax check')
  process.exit(check.status === null ? 1 : check.status)
}

const written = readFileSync(TARGET, 'utf8')
if (!written.startsWith('window.__ModuleLoader__.load(')) {
  console.error('lib/client.js does not start with the loader shell')
  process.exit(1)
}
if (!written.includes(ALLOWED_REQUIRE)) {
  console.error('lib/client.js does not require react')
  process.exit(1)
}
if (written.includes('@deepseek-ai/dsh-client')) {
  console.error('lib/client.js references a host client package that does not exist in this build')
  process.exit(1)
}
console.log('lib/client.js written: ' + String(Buffer.byteLength(written, 'utf8')) + ' bytes')
