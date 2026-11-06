/**
 * Minimal authenticated HTTP client for a self-hosted code host: the token is read from a 0600 file on every call, the
 * base URL must be https (loopback http only), and every path must stay inside one of the configured projects.
 * It is the only network seam of the hosting adapters, so tests inject their own `fetchFn` or their own `HostingApi`.
 */
import { readFile, stat } from 'node:fs/promises'

/** One HTTP answer: status, parsed JSON body (`null` when empty), response headers, and the resolved base URL. */
export interface HostingAnswer { status: number; body: unknown; headers: Headers; baseUrl: string }

/** The client a hosting adapter reads and writes through; `baseUrl` is also the origin of a change request's page URL. */
export interface HostingApi {
  readonly baseUrl: string
  get(path: string, signal?: AbortSignal): Promise<HostingAnswer>
  post(path: string, body: unknown, signal?: AbortSignal): Promise<HostingAnswer>
}

export interface HostingApiOptions {
  /** Origin of the host, such as `https://gitlab.example.com`; plain http is accepted only on 127.0.0.1. */
  baseUrl: string
  /** File holding the access token (mode 0600); read again on every call so a rotated token needs no restart. */
  tokenFile: string
  /** Projects whose paths a call may name, decoded (`group/project`) or URL-encoded (`group%2Fproject`). */
  projectWhitelist: string[]
  fetchFn?: typeof fetch
}

const DENIED = 'Hosting calls are restricted to the configured projects'
/** How long one call may take before it is aborted; a hung host must not stall a polling round forever. */
const TIMEOUT_MS = 30_000

/** Rejects a base URL that is not https (or loopback http) and returns it without a trailing slash. */
function checkBaseUrl(baseUrl: string): string {
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new Error('The hosting base URL is not an absolute URL') }
  const loopback = url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The hosting base URL must use https; plain http is allowed only on 127.0.0.1')
  }
  return baseUrl.replace(/\/+$/, '')
}

/** True when `label` is a whitelisted project or one of its subgroups (a prefix ending at a path segment). */
const allowed = (label: string, whitelist: readonly string[]): boolean =>
  whitelist.some(entry => label === entry || label.startsWith(`${entry}/`))

/**
 * Rejects a path outside `/projects/<whitelisted project>` before any request is made, including an encoded or plain
 * `..` segment; the project segment may be URL-encoded (`group%2Fproject`) and a whitelisted group covers its subgroups.
 */
function checkPath(path: string, whitelist: readonly string[]): void {
  if (!path.startsWith('/projects/')) throw new Error(DENIED)
  const end = path.search(/[?#]/)
  const pathname = end < 0 ? path : path.slice(0, end)
  let decodedPath: string
  let project: string
  let decoded: string
  try {
    decodedPath = decodeURIComponent(pathname)
    project = pathname.slice('/projects/'.length).split('/')[0] ?? ''
    decoded = decodeURIComponent(project)
  } catch { throw new Error(DENIED) }
  if (!project || /(^|\/)\.\.?(\/|$)/.test(decodedPath)) throw new Error(DENIED)
  if (!allowed(project, whitelist) && !allowed(decoded, whitelist)) throw new Error(DENIED)
}

/** Reads the token file after checking it is a regular 0600 file; failures never echo the token. */
async function readToken(tokenFile: string): Promise<string> {
  const info = await stat(tokenFile)
  if (!info.isFile()) throw new Error('The hosting token file is not a regular file')
  if ((info.mode & 0o777) !== 0o600) throw new Error('The hosting token file must be owner-only (mode 0600)')
  const token = (await readFile(tokenFile, 'utf8')).trim()
  if (!token) throw new Error('The hosting token file is empty')
  return token
}

/** Builds the client of one host configuration; validation of the base URL happens here, path and token checks on every call. */
export function createHostingApi(options: HostingApiOptions): HostingApi {
  const baseUrl = checkBaseUrl(options.baseUrl)
  const whitelist = options.projectWhitelist.map(project => project.trim()).filter(Boolean)
  const fetcher = options.fetchFn ?? fetch
  const send = async (method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<HostingAnswer> => {
    checkPath(path, whitelist)
    const token = await readToken(options.tokenFile)
    const budget = AbortSignal.timeout(TIMEOUT_MS)
    const answer = await fetcher(`${baseUrl}${path}`, {
      method,
      headers: { 'PRIVATE-TOKEN': token, ...body === undefined ? {} : { 'Content-Type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: signal ? AbortSignal.any([signal, budget]) : budget,
    })
    const text = await answer.text()
    let parsed: unknown = null
    if (text.trim()) {
      try { parsed = JSON.parse(text) } catch { throw new Error(`The hosting API returned a non-JSON body (HTTP ${answer.status})`) }
    }
    return { status: answer.status, body: parsed, headers: answer.headers, baseUrl }
  }
  return {
    baseUrl,
    get: (path, signal) => send('GET', path, undefined, signal),
    post: (path, body, signal) => send('POST', path, body, signal),
  }
}