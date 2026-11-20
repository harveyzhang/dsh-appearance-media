// dsh-appearance-media — the catalog and health routes.
//
//   GET /appearance-media/catalog.json   the media catalog the browser half reads
//   GET /appearance-media/health         a liveness probe that names the data dir
//
// Both are `exact` routes. `exact` matches the pathname alone, so a request
// carrying a query string still lands here, and `/appearance-media/health/anything`
// does NOT: a prefix route would answer 200 for every sub-path, which is a
// wider match than the route means.
//
// Both are read-only, so both accept GET and HEAD and refuse everything else
// with 405. A route that only reads has no side effect for a stray request to
// trigger, so there is nothing to protect beyond saying so.
//
// THE CATALOG IS SCANNED FRESH, ON EVERY REQUEST.
//
// The media directory is re-read each time this route is asked, so a file the
// user drops into it shows up on the very next request — there is no index and
// no snapshot. (A route that answers from a snapshot is a route that lies;
// that is the same lesson Task 1 learned the hard way.)
//
// The `revision` is the LEDGER's revision, read now. The Host increments
// nothing on a plugin's behalf, so the authority for "did the library change"
// is the ledger (`lib/store.js`), and it is read per request for the same
// reason: a revision that is snapshotted at mount time is a revision that
// lies.
//
// The upload and remove routes live in `lib/routes/upload.js`, and the media
// route — the bytes of one entry and the deletion of that entry — lives in
// `lib/routes/media.js`.

import { listCatalog, publicEntry } from '../catalog.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/appearance-media'

/** The catalog manifest. */
export const CATALOG_PATH = `${ROUTE_PREFIX}/catalog.json`

/** The liveness probe. */
export const HEALTH_PATH = `${ROUTE_PREFIX}/health`

/** The version this build reports. Kept in step with package.json. */
export const PLUGIN_VERSION = '0.1.0'

/**
 * Answer one JSON response.
 *
 * `no-store` on both routes: the catalog changes as soon as the media library
 * exists, and the health probe is read by a script that must never see a
 * cached answer.
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
    'Cache-Control': 'no-store',
    ...(extraHeaders ?? {}),
  })
  res.end(body)
}

/**
 * Whether the request method is one this route answers.
 *
 * @param req - incoming request.
 * @returns true for GET and HEAD.
 */
function isReadMethod(req) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

/**
 * Turn an input into a per-request reader.
 *
 * TWO forms are accepted, and both are legal:
 *
 *   - a READER (`() => value`) — the handler calls it on every request, so a
 *     volatile config field that changes while the host runs is answered with
 *     its CURRENT value. This is the whole point of `.volatile()`: a setting
 *     that takes effect without a restart must not be snapshotted at apply
 *     time.
 *   - a plain VALUE — wrapped into a constant reader, so an existing caller
 *     that passes a snapshot still works (and still answers a fixed value).
 *
 * @param reader - the reader, when there is one.
 * @param fallback - the value to answer when the reader returns undefined.
 * @returns a reader that never returns undefined.
 */
function toReader(reader, fallback) {
  if (typeof reader === 'function') {
    return () => {
      const value = reader()
      return value === undefined ? fallback : value
    }
  }
  return () => fallback
}

/**
 * Build the two route descriptors the Host half registers.
 *
 * The descriptors are plain data: `index.js` owns the registration and the
 * cleanup, and this module owns WHAT a route answers. That split is what makes
 * the offline suite able to drive the real handlers without a web server.
 *
 * @param readDataDir - a reader for the data directory, called per request.
 * @param readRevision - a reader for the catalog revision, called per request.
 * @param dataDir - the data directory, when it is given as a plain value.
 * @param revision - the catalog revision, when it is given as a plain value.
 * @param version - the version the health probe reports.
 * @returns the route descriptors, in registration order.
 */
export function buildRoutes({
  readDataDir,
  readRevision,
  dataDir,
  revision = 0,
  version = PLUGIN_VERSION,
} = {}) {
  const readDir = toReader(readDataDir, dataDir)
  const readRev = toReader(readRevision, revision)

  return [
    {
      kind: 'exact',
      path: CATALOG_PATH,
      handler: (req, res) => {
        try {
          if (!isReadMethod(req)) {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 GET 和 HEAD。' }, { Allow: 'GET, HEAD' })
            return
          }
          const current = readRev()
          // The library, scanned now.
          const library = listCatalog(readDir())
          sendJson(res, 200, {
            ok: true,
            // The catalog's revision, read NOW. It changes whenever the entry
            // set changes, so a browser can tell a stale answer from a current
            // one — and it comes from the LEDGER, because the Host increments
            // nothing on a plugin's behalf.
            revision: typeof current === 'number' && Number.isFinite(current) ? current : 0,
            // Every media entry the browser half may play.
            entries: library.entries.map(publicEntry),
            // Entries the Host refused to publish, with the reason. Only the
            // base name — an absolute path would leak the user's home
            // directory to the browser.
            skipped: library.skipped,
          })
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
          else res.end()
        }
      },
    },
    {
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (req, res) => {
        try {
          if (!isReadMethod(req)) {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 GET 和 HEAD。' }, { Allow: 'GET, HEAD' })
            return
          }
          sendJson(res, 200, {
            ok: true,
            version,
            // The data directory, read NOW. A volatile `dataDir` edit is
            // visible on the very next request, without a restart.
            dataDir: readDir(),
          })
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
          else res.end()
        }
      },
    },
  ]
}
