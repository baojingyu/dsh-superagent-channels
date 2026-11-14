/**
 * Yunxiao OAuth 2.0 sign-in: dynamic client registration, authorization code with PKCE (S256), a loopback callback, and
 * refresh. The result is the same owner-only token file the Personal Access Token path uses, so every reader of that file
 * keeps working; the client can renew the access token in place when the host answers 401.
 *
 * The endpoints come from the authorization-server metadata, never hard-coded: Yunxiao may serve the authorization and
 * token endpoints from different hosts. See `ADR-010`.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'

/** The three endpoints the flow uses. `registrationEndpoint` is absent when the site does not offer dynamic registration. */
export interface OAuthEndpoints { authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint?: string }
/** Tokens as the token endpoint returns them. */
export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresAt?: string; tokenType?: string }
/** What is kept beside the token file so a renewal needs no browser. */
export interface StoredOAuth { site: string; clientId: string; tokenEndpoint: string; refreshToken?: string; expiresAt?: string }
/** Everything one sign-in needs; every external effect is injectable so the flow can be tested without a browser. */
export interface AuthorizeOptions {
  /** The site whose authorization server signs in: `https://openapi-rdc.aliyuncs.com` for the central site. */
  baseUrl: string
  /** The name registered with the authorization server, shown on its consent page. */
  clientName?: string
  fetchFn?: typeof fetch
  /** Opens the authorization URL; the default starts the platform's browser. */
  openBrowser?: (url: string) => void
  /** How long to wait for the browser callback; five minutes when omitted. */
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_BASE_URL = 'https://openapi-rdc.aliyuncs.com'
const CALLBACK_PATH = '/callback'
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const CLIENT_NAME = 'dsh-superagent-multi-channel'

/** base64url without padding, the encoding PKCE and OAuth state use. */
const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

/** A PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Reads the authorization-server metadata, falling back to the documented paths when it cannot be fetched. */
export async function discover(baseUrl: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<OAuthEndpoints> {
  const base = baseUrl.replace(/\/$/, '')
  const fallback: OAuthEndpoints = { authorizationEndpoint: `${base}/v1/oauth2/authorize`, tokenEndpoint: `${base}/v1/oauth2/token`,
    registrationEndpoint: `${base}/v1/oauth2/register` }
  try {
    const response = await fetchFn(`${base}/.well-known/oauth-authorization-server`,
      { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) })
    if (!response.ok) return fallback
    const body = await response.json() as Record<string, unknown>
    const authorizationEndpoint = typeof body.authorization_endpoint === 'string' ? body.authorization_endpoint : ''
    const tokenEndpoint = typeof body.token_endpoint === 'string' ? body.token_endpoint : ''
    if (!authorizationEndpoint || !tokenEndpoint) return fallback
    return { authorizationEndpoint, tokenEndpoint,
      ...typeof body.registration_endpoint === 'string' && body.registration_endpoint ? { registrationEndpoint: body.registration_endpoint } : {} }
  } catch {
    return fallback
  }
}

/** Registers this installation as a public client; Yunxiao issues no secret, so only the `client_id` comes back. */
export async function registerClient(endpoints: OAuthEndpoints, redirectUri: string, fetchFn: typeof fetch = fetch,
  clientName = CLIENT_NAME, signal?: AbortSignal): Promise<string> {
  if (!endpoints.registrationEndpoint) throw new Error('The Yunxiao site offers no dynamic client registration; use a personal access token')
  const response = await fetchFn(endpoints.registrationEndpoint, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' }),
    ...(signal ? { signal } : {}) })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || typeof body.client_id !== 'string' || !body.client_id) {
    throw new Error(`Yunxiao client registration failed with HTTP ${response.status}: ${summarize(body)}`)
  }
  return body.client_id
}

/** The authorization URL the browser opens. */
export function authorizeUrl(endpoints: OAuthEndpoints, input: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(endpoints.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', input.state)
  return url.toString()
}

/**
 * The command that hands a URL to the platform's browser, as `[command, args]`. Windows must not go through `cmd`: a
 * `cmd /c start "" <url>` line splits on `&`, so the browser received only `?response_type=code` and answered
 * "invalid client_id or redirect_uri". `rundll32 url.dll,FileProtocolHandler` takes the URL as one argv entry, so every
 * query parameter arrives.
 */
export function browserCommand(url: string): [string, string[]] {
  return process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
}

/** Starts the platform's browser without holding a pipe, so a sandboxed shell cannot block on it. */
export function openInBrowser(url: string): void {
  const [command, args] = browserCommand(url)
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

interface CallbackResult { code?: string; error?: string; state?: string }
/** Resolves with the authorization code once the browser comes back on `server`, or rejects on error, timeout, or abort. */
function waitForCallback(server: ReturnType<typeof createServer>, port: number, expectedState: string, timeoutMs: number,
  signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== CALLBACK_PATH) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('Not found'); return }
      const result: CallbackResult = { ...(url.searchParams.get('code') ? { code: url.searchParams.get('code')! } : {}),
        ...(url.searchParams.get('error') ? { error: url.searchParams.get('error')! } : {}),
        ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {}) }
      const ok = !result.error && !!result.code && result.state === expectedState
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><meta charset="utf-8"><title>Yunxiao</title><p>${ok
        ? '授权完成，可以关闭此页面。' : '授权未完成，请回到 DSH 查看原因。'}</p>`)
      finish()
      if (!ok) { reject(new Error(result.error ? `Yunxiao authorization failed: ${result.error}`
        : 'Yunxiao authorization returned no code, or a state that does not match')); return }
      resolve(result.code!)
    })
    let settled = false
    const finish = (): void => { if (settled) return; settled = true; server.close(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const timer = setTimeout(() => { finish(); reject(new Error('Timed out waiting for the Yunxiao sign-in to come back')) }, timeoutMs)
    const onAbort = (): void => { finish(); reject(new Error('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    server.on('error', error => { finish(); reject(error) })
  })
}

/** Runs the whole sign-in: register, open the browser, take the code, exchange it. */
export async function authorizeWithBrowser(options: AuthorizeOptions): Promise<{ tokens: OAuthTokens; stored: StoredOAuth }> {
  const fetchFn = options.fetchFn ?? fetch
  const base = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  const endpoints = await discover(base, fetchFn, options.signal)
  // The callback server listens first, so the redirect URI names the exact port the browser will reach.
  const server = createServer()
  const port = await listen(server, options.signal)
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const clientId = await registerClient(endpoints, redirectUri, fetchFn, options.clientName ?? CLIENT_NAME, options.signal)
  const { verifier, challenge } = pkcePair()
  const state = base64url(randomBytes(16))
  const url = authorizeUrl(endpoints, { clientId, redirectUri, challenge, state })
  const waiting = waitForCallback(server, port, state, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal)
  ;(options.openBrowser ?? openInBrowser)(url)
  try {
    const code = await waiting
    const tokens = await exchangeCode(endpoints.tokenEndpoint, { code, redirectUri, clientId, verifier }, fetchFn, options.signal)
    return { tokens, stored: { site: base, clientId, tokenEndpoint: endpoints.tokenEndpoint,
      ...tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}, ...tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {} } }
  } catch (error) {
    server.close()
    const message = error instanceof Error ? error.message : String(error)
    // A headless host may not open a browser; the address is public (a PKCE challenge, not a secret), so name it.
    throw new Error(message.includes('Timed out') ? `${message}。若浏览器没有自动打开，请手动访问该地址完成授权：${url}` : message)
  }
}

/** Listens on an ephemeral loopback port and resolves with the port the OS chose. */
function listen(server: ReturnType<typeof createServer>, signal?: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve(address.port)
      else { server.close(); reject(new Error('Could not open a loopback port for the sign-in')) }
    })
    signal?.addEventListener('abort', () => { server.close(); reject(new Error('aborted')) }, { once: true })
  })
}

/** Trades an authorization code for tokens (public client: no secret, PKCE verifier instead). */
export async function exchangeCode(tokenEndpoint: string,
  input: { code: string; redirectUri: string; clientId: string; verifier: string }, fetchFn: typeof fetch = fetch,
  signal?: AbortSignal): Promise<OAuthTokens> {
  return tokenRequest(tokenEndpoint, { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
    client_id: input.clientId, code_verifier: input.verifier }, fetchFn, signal)
}

/** Renews the access token from the stored refresh token. */
export async function refreshTokens(stored: Pick<StoredOAuth, 'tokenEndpoint' | 'clientId' | 'refreshToken'>,
  fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<OAuthTokens> {
  if (!stored.refreshToken) throw new Error('No Yunxiao refresh token is stored')
  return tokenRequest(stored.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: stored.refreshToken,
    client_id: stored.clientId }, fetchFn, signal)
}

async function tokenRequest(tokenEndpoint: string, form: Record<string, string>, fetchFn: typeof fetch, signal?: AbortSignal): Promise<OAuthTokens> {
  const response = await fetchFn(tokenEndpoint, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(), ...(signal ? { signal } : {}) })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  if (!response.ok || !accessToken) throw new Error(`Yunxiao token request failed with HTTP ${response.status}: ${summarize(body)}`)
  const expiresIn = Number(body.expires_in)
  return { accessToken,
    ...typeof body.refresh_token === 'string' && body.refresh_token ? { refreshToken: body.refresh_token } : {},
    ...Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {},
    ...typeof body.token_type === 'string' ? { tokenType: body.token_type } : {} }
}

/** Where the refresh material lives: a sibling of the token file, never the token file itself. */
export const storedPath = (tokenFile: string): string => `${tokenFile}.oauth.json`

/** Reads the stored refresh material, or nothing when the token came from a personal access token. */
export function readStored(tokenFile: string): StoredOAuth | undefined {
  try {
    const parsed = JSON.parse(readFileSync(storedPath(tokenFile), 'utf8')) as Partial<StoredOAuth>
    return typeof parsed.clientId === 'string' && typeof parsed.tokenEndpoint === 'string' && typeof parsed.site === 'string'
      ? { site: parsed.site, clientId: parsed.clientId, tokenEndpoint: parsed.tokenEndpoint,
        ...typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {},
        ...typeof parsed.expiresAt === 'string' ? { expiresAt: parsed.expiresAt } : {} }
      : undefined
  } catch { return undefined }
}

/** Writes the access token (the file every reader uses) and, beside it, what a renewal needs; both owner-only. */
export function writeStored(tokenFile: string, input: { tokens: OAuthTokens; stored: StoredOAuth }): void {
  mkdirSync(dirname(tokenFile), { recursive: true })
  writeFileSync(tokenFile, `${input.tokens.accessToken}\n`, { mode: 0o600 })
  writeFileSync(storedPath(tokenFile), `${JSON.stringify({ ...input.stored,
    ...input.tokens.refreshToken ? { refreshToken: input.tokens.refreshToken } : {},
    ...input.tokens.expiresAt ? { expiresAt: input.tokens.expiresAt } : {} }, null, 2)}\n`, { mode: 0o600 })
  // `writeFileSync`'s mode is filtered by the umask; the owner-only rule is what the reader enforces, so set it exactly.
  try { chmodSync(tokenFile, 0o600); chmodSync(storedPath(tokenFile), 0o600) } catch { /* Windows keeps its ACL instead. */ }
}

/** True when this token file came from the OAuth flow (and so can be renewed without a person). */
export const canRenew = (tokenFile: string): boolean => existsSync(storedPath(tokenFile))

/**
 * Renews the access token after a 401 and rewrites both files; false when there is nothing to renew with, so the caller
 * reports the 401 as it is.
 */
export async function renewAccessToken(tokenFile: string, fetchFn: typeof fetch = fetch, timeoutMs = 15_000): Promise<boolean> {
  const stored = readStored(tokenFile)
  if (!stored?.refreshToken) return false
  try {
    const signal = AbortSignal.timeout(timeoutMs)
    const tokens = await refreshTokens(stored, fetchFn, signal)
    writeStored(tokenFile, { tokens, stored })
    return true
  } catch { return false }
}

function summarize(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body) ?? ''
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}
