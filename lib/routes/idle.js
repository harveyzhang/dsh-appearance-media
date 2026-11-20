// dsh-appearance-media — the idle probe route.
//
//   GET /appearance-media/system-idle.json   how long the whole machine has
//                                             been idle, read now
//
// ★ A ROUTE THAT ONLY READS IS GET-ONLY.
//
//   There is no side effect here for a stray request to trigger, and the
//   answer is a number that must be cheap enough to poll. So it accepts GET
//   and HEAD and refuses everything else with a 405 that carries an `Allow`
//   header saying what is allowed.
//
// ★ THE NAME IS DELIBERATE.
//
//   `system-idle.json`, not `idle.json`: the screensaver's MATERIAL is a
//   different thing, and a name that could be read as a manifest of materials
//   would be a trap for the next reader.
//
// ★ THE ANSWER NEVER LIES ABOUT ITSELF.
//
//   { ok, idleMs, status, reason }
//
//   * `status` is one of `ok` / `starting` / `unavailable`;
//   * `idleMs` is a NUMBER only when the status is `ok` — otherwise it is
//     `null`.
//
// ★ `ok` IS THE PROBE'S ANSWER, NOT THE ROUTE'S.
//
//   The HTTP status is 200 whenever the route could answer at all: "this
//   machine cannot tell you how idle it is" is a legitimate answer, not a
//   server error, and a browser that has to tell two kinds of failure apart
//   reads `status` for it.
//
// ★ THE READER IS CALLED PER REQUEST.
//
//   A probe that answers from a snapshot answers a question about the past,
//   and the screensaver's threshold is compared against a reading that has to
//   be true NOW.

import { STATUS_OK, readIdle } from '../probe.js'

/** The route. */
export const IDLE_PATH = '/appearance-media/system-idle.json'

/** The methods this route answers, in the order they are announced. */
export const IDLE_ALLOW = 'GET, HEAD'

/**
 * Answer one JSON response.
 *
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param value - the JSON value.
 * @param extraHeaders - additional response headers, e.g. `Allow` on a 405.
 */
function sendJson(res, status, value, extraHeaders) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    // ★ EXACTLY `no-store`. A cached idle reading is a reading about the past,
    // and the screensaver compares it against a threshold that is about now.
    'Cache-Control': 'no-store',
    ...(extraHeaders ?? {}),
  })
  res.end(body)
}

/**
 * Build the idle route.
 *
 * The descriptor is plain data: `index.js` owns the registration and the
 * cleanup, and this module owns WHAT the route answers.
 *
 * @param {{readIdle?: Function}} options - the seams.
 * @returns the route descriptors, in registration order.
 */
export function buildIdleRoutes({ readIdle: reader } = {}) {
  const read = typeof reader === 'function' ? reader : readIdle

  return [
    {
      kind: 'exact',
      path: IDLE_PATH,
      handler: async (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'GET' && method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 GET 和 HEAD。' }, { Allow: IDLE_ALLOW })
            return
          }
          let answer = null
          try {
            answer = await read()
          } catch (error) {
            answer = null
          }
          // ★ A PROBE THAT THREW IS `unavailable`, NOT A ZERO.
          if (answer === null || typeof answer !== 'object') {
            sendJson(res, 200, { ok: false, idleMs: null, status: 'unavailable', reason: 'probe-error' })
            return
          }
          const status = typeof answer.status === 'string' ? answer.status : 'unavailable'
          const usable = status === STATUS_OK
          // ★ `idleMs` IS A NUMBER ONLY WHEN THE STATUS IS `ok`.
          const idleMs = usable && typeof answer.idleMs === 'number' && Number.isFinite(answer.idleMs)
            ? answer.idleMs
            : null
          sendJson(res, 200, {
            ok: usable,
            idleMs,
            status,
            reason: typeof answer.reason === 'string' ? answer.reason : 'unknown',
          })
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
          else res.end()
        }
      },
    },
  ]
}
