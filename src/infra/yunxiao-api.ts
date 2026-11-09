/** Minimal Aliyun Yunxiao (Projex) OpenAPI client: token-file auth, organization whitelist, and path confinement. */
import { readFileSync, statSync } from 'node:fs'
import { requireOwnerOnly } from './secret-file.ts'

/** Response of one Yunxiao OpenAPI call; `body` is the decoded JSON (or raw text when the payload is not JSON). */
export interface YunxiaoResult { status: number; body: any }

/** Query of a GET; array values repeat the parameter, and `undefined` values are dropped. */
export type YunxiaoQuery = Record<string, string | number | boolean | readonly (string | number)[] | undefined>

/** The two verbs the work domain needs; tests inject a fake implementation of this interface. */
export interface YunxiaoApi {
  get(path: string, query?: YunxiaoQuery): Promise<YunxiaoResult>
  post(path: string, body: unknown): Promise<YunxiaoResult>
  /** Update in place; Projex's write-back is a `PUT` on the work item. */
  put(path: string, body: unknown): Promise<YunxiaoResult>
}

/** Everything the client needs: where to call, whose token to read, and which organizations are allowed. */
export interface YunxiaoApiOptions {
  baseUrl?: string
  /** File holding the `x-yunxiao-token` value; read again on every request and required to be mode 0600. */
  tokenFile: string
  /** Organization IDs this client may address; every other organization is refused. */
  orgWhitelist: readonly string[]
  /** How long one call may take before it is aborted; 15s when omitted. */
  timeoutMs?: number
  /** Fetch implementation, injectable for tests. */
  fetchFn?: typeof fetch
}

/** A non-2xx Yunxiao answer; `status` lets callers distinguish a vanished resource (404/410) from a retryable failure. */
export class YunxiaoHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'YunxiaoHttpError'
  }
}

const DEFAULT_BASE_URL = 'https://openapi-rdc.aliyuncs.com'
const API_PREFIX = '/oapi/v1/'
/** Default budget of one call; a hung API must not stall a polling round. */
const DEFAULT_TIMEOUT_MS = 15_000
const DENIED = 'Yunxiao calls are restricted to the configured organizations'

/** Rejects a base URL that is not https (or loopback http), like the hosting client; the default is a fixed https host. */
function checkBaseUrl(baseUrl: string): string {
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new Error('The Yunxiao base URL is not an absolute URL') }
  const loopback = url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The Yunxiao base URL must use https; plain http is allowed only on 127.0.0.1')
  }
  return baseUrl
}

/** Builds the client; no network, file read, or permission check happens until a request is made. */
export function createYunxiaoApi(options: YunxiaoApiOptions): YunxiaoApi {
  const baseUrl = checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetchFn ?? fetch
  const send = async (method: 'GET' | 'POST' | 'PUT', path: string, query?: YunxiaoQuery, body?: unknown): Promise<YunxiaoResult> => {
    if (!path.startsWith(API_PREFIX)) throw new Error(`Yunxiao path must start with ${API_PREFIX}`)
    // Refuse a path that could leave its organization before the URL is built, then again on the built URL's normalized path.
    checkPath(path, options.orgWhitelist)
    const token = readToken(options.tokenFile)
    const url = buildUrl(baseUrl, path, query)
    checkPath(new URL(url).pathname, options.orgWhitelist)
    let response: Response
    try {
      response = await fetchFn(url, { method,
        headers: { 'x-yunxiao-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new Error(redact(`Yunxiao request failed: ${messageOf(error)}`, token))
    }
    const text = await response.text()
    const parsed = parseBody(text)
    if (!response.ok) {
      throw new YunxiaoHttpError(response.status,
        redact(`Yunxiao request failed with HTTP ${response.status}: ${summaryOf(parsed)}`, token))
    }
    return { status: response.status, body: parsed }
  }
  return {
    get: (path, query) => send('GET', path, query),
    post: (path, body) => send('POST', path, undefined, body),
    put: (path, body) => send('PUT', path, undefined, body),
  }
}

/**
 * Reads the token file on each call and refuses any permission other than 0600 (the token never leaves this file
 * otherwise); on Windows the owner-only bit test is skipped, because the synthesized mode carries no ACL information.
 */
function readToken(file: string): string {
  let mode: number
  try {
    mode = statSync(file).mode
  } catch (error) {
    throw new Error(`Yunxiao token file is not readable: ${file}: ${messageOf(error)}`)
  }
  requireOwnerOnly(mode, file, 'Yunxiao token file')
  let token: string
  try {
    token = readFileSync(file, 'utf8').trim()
  } catch (error) {
    throw new Error(`Yunxiao token file is not readable: ${file}: ${messageOf(error)}`)
  }
  if (!token) throw new Error(`Yunxiao token file is empty: ${file}`)
  return token
}

/** Extracts the organization ID from a pathname and requires it to be one path segment. */
function organizationOf(pathname: string): string {
  const match = /\/organizations\/([^/?#]+)/.exec(pathname)
  if (!match?.[1]) throw new Error('Yunxiao path has no organization segment')
  return decodeURIComponent(match[1])
}

/**
 * Rejects a path outside a whitelisted organization before any request is made, mirroring the hosting client: the pathname
 * is decoded first and split on `/`, and any `.` or `..` segment (plain, `%2e%2e`, or `%2E%2E`) is refused, so the check
 * cannot be bypassed by an encoded segment; then the organization segment must be on the whitelist.
 */
function checkPath(path: string, whitelist: readonly string[]): void {
  const end = path.search(/[?#]/)
  const pathname = end < 0 ? path : path.slice(0, end)
  let decodedPath: string
  let organization: string
  try {
    decodedPath = decodeURIComponent(pathname)
    organization = organizationOf(pathname)
  } catch { throw new Error(DENIED) }
  if (decodedPath.split('/').some(segment => segment === '.' || segment === '..')) throw new Error(DENIED)
  if (!whitelist.includes(organization)) throw new Error(`Yunxiao organization is not allowed: ${organization}`)
}

/** Joins the base URL and path and encodes the query; arrays repeat the parameter (such as several categories). */
function buildUrl(baseUrl: string, path: string, query?: YunxiaoQuery): string {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item))
  }
  return url.toString()
}

/** Parses JSON when the payload is JSON, otherwise keeps the raw text. */
function parseBody(text: string): unknown {
  if (!text) return undefined
  try { return JSON.parse(text) as unknown } catch { return text }
}

/** Keeps diagnostics short and free of the token, which a host might echo in an error body. */
function summaryOf(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body) ?? ''
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}
function redact(text: string, token: string): string {
  return token ? text.split(token).join('[redacted]') : text
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}