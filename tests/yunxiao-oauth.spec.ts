/** Yunxiao OAuth 2.0 sign-in: metadata discovery, DCR, PKCE, the loopback callback, and the token file it writes. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { authorizeUrl, authorizeWithBrowser, browserCommand, discover, pkcePair, readStored, renewAccessToken, storedPath,
  writeStored, type OAuthTokens } from '../src/infra/yunxiao-oauth.ts'

const json = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response
const b64url = (text: string): string => createHash('sha256').update(text).digest('base64url')

describe('PKCE', () => {
  it('derives an S256 challenge from the verifier, both base64url without padding', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(b64url(verifier))
    expect(challenge).not.toBe(verifier)
  })
})

describe('endpoint discovery', () => {
  it('reads the authorization-server metadata', async () => {
    const fetchFn = (async () => json({ issuer: 'https://site', authorization_endpoint: 'https://auth/authorize',
      token_endpoint: 'https://auth/token', registration_endpoint: 'https://auth/register' })) as unknown as typeof fetch
    await expect(discover('https://site.example', fetchFn)).resolves.toEqual({ authorizationEndpoint: 'https://auth/authorize',
      tokenEndpoint: 'https://auth/token', registrationEndpoint: 'https://auth/register' })
  })
  it('falls back to the documented paths when the metadata is absent or incomplete', async () => {
    const absent = (async () => json({}, 404)) as unknown as typeof fetch
    await expect(discover('https://site.example/', absent)).resolves.toEqual({
      authorizationEndpoint: 'https://site.example/v1/oauth2/authorize', tokenEndpoint: 'https://site.example/v1/oauth2/token',
      registrationEndpoint: 'https://site.example/v1/oauth2/register' })
    const incomplete = (async () => json({ authorization_endpoint: 'https://auth/authorize' })) as unknown as typeof fetch
    expect((await discover('https://site.example', incomplete)).tokenEndpoint).toBe('https://site.example/v1/oauth2/token')
  })
})

describe('browser sign-in', () => {
  it('registers a public client, sends the browser to authorize with PKCE, and exchanges the code', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, ...(init ? { init } : {}) })
      if (url.endsWith('/.well-known/oauth-authorization-server')) return json({ authorization_endpoint: 'https://auth.test/authorize',
        token_endpoint: 'https://auth.test/token', registration_endpoint: 'https://auth.test/register' })
      if (url === 'https://auth.test/register') return json({ client_id: 'cid-1' })
      if (url === 'https://auth.test/token') return json({ access_token: 'oat-1', refresh_token: 'ort-1', expires_in: 3600,
        token_type: 'Bearer' })
      throw new Error(`unexpected request ${url}`)
    }) as unknown as typeof fetch
    let opened = ''
    const openBrowser = (url: string): void => {
      opened = url
      // What the browser does: GET the loopback redirect with the code and the state it was given.
      const auth = new URL(url)
      const redirect = auth.searchParams.get('redirect_uri')!
      const state = auth.searchParams.get('state')!
      void fetch(`${redirect}?code=abc&state=${encodeURIComponent(state)}`).catch(() => {})
    }
    const { tokens, stored } = await authorizeWithBrowser({ baseUrl: 'https://site.test', fetchFn, openBrowser, timeoutMs: 5000 })
    expect(tokens).toMatchObject({ accessToken: 'oat-1', refreshToken: 'ort-1', tokenType: 'Bearer' })
    expect(tokens.expiresAt).toBeDefined()
    expect(stored).toMatchObject({ site: 'https://site.test', clientId: 'cid-1', tokenEndpoint: 'https://auth.test/token',
      refreshToken: 'ort-1' })
    const auth = new URL(opened)
    expect(auth.searchParams.get('response_type')).toBe('code')
    expect(auth.searchParams.get('client_id')).toBe('cid-1')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('scope')).toBeNull()
    // Registration carried the loopback redirect and the public-client method.
    const registration = JSON.parse(String(calls.find(call => call.url === 'https://auth.test/register')!.init!.body))
    expect(registration).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
    expect(registration.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // The token request proves the exchange: its verifier hashes to the challenge the browser was sent.
    const form = new URLSearchParams(String(calls.find(call => call.url === 'https://auth.test/token')!.init!.body))
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('abc')
    expect(b64url(form.get('code_verifier')!)).toBe(auth.searchParams.get('code_challenge'))
  })
  it('rejects a callback whose state does not match, without exchanging anything', async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/.well-known/oauth-authorization-server')) return json({ authorization_endpoint: 'https://auth.test/authorize',
        token_endpoint: 'https://auth.test/token', registration_endpoint: 'https://auth.test/register' })
      if (url === 'https://auth.test/register') return json({ client_id: 'cid-1' })
      return json({ access_token: 'should-not-be-used' })
    }) as unknown as typeof fetch
    const openBrowser = (url: string): void => {
      const redirect = new URL(url).searchParams.get('redirect_uri')!
      void fetch(`${redirect}?code=abc&state=forged`).catch(() => {})
    }
    await expect(authorizeWithBrowser({ baseUrl: 'https://site.test', fetchFn, openBrowser, timeoutMs: 5000 }))
      .rejects.toThrow(/state that does not match/)
  })
})

describe('token storage and renewal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yunxiao-oauth-'))
  afterAll(() => { rmSync(directory, { recursive: true, force: true }) })
  const tokens: OAuthTokens = { accessToken: 'oat-1', refreshToken: 'ort-1', expiresAt: '2026-01-01T00:00:00.000Z', tokenType: 'Bearer' }
  const stored = { site: 'https://site.test', clientId: 'cid-1', tokenEndpoint: 'https://auth.test/token', refreshToken: 'ort-1' }

  it('writes the access token where every reader expects it, and the refresh material beside it', () => {
    const file = join(directory, 'token')
    writeStored(file, { tokens, stored })
    expect(readFileSync(file, 'utf8').trim()).toBe('oat-1')
    expect(readStored(file)).toMatchObject({ clientId: 'cid-1', refreshToken: 'ort-1' })
    expect(storedPath(file)).toBe(`${file}.oauth.json`)
    // The owner-only rule is a POSIX one (Windows reports a synthesized mode); `secret-file.spec` covers that branch.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(storedPath(file)).mode & 0o777).toBe(0o600)
    }
  })
  it('reads nothing from a personal-access-token file, so a 401 is not retried with no refresh token', async () => {
    const file = join(directory, 'pat-token')
    writeStored(file, { tokens: { accessToken: 'pt-plain' }, stored: { ...stored, refreshToken: undefined } })
    expect(readStored(file)?.refreshToken).toBeUndefined()
    expect(await renewAccessToken(file, (async () => json({}, 500)) as unknown as typeof fetch)).toBe(false)
  })
  it('renews in place after a 401 and rewrites both files', async () => {
    const file = join(directory, 'renew')
    writeStored(file, { tokens, stored })
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://auth.test/token')
      expect(new URLSearchParams(String(init!.body)).get('grant_type')).toBe('refresh_token')
      return json({ access_token: 'oat-2', refresh_token: 'ort-2', expires_in: 3600 })
    }) as unknown as typeof fetch
    await expect(renewAccessToken(file, fetchFn)).resolves.toBe(true)
    expect(readFileSync(file, 'utf8').trim()).toBe('oat-2')
    expect(readStored(file)?.refreshToken).toBe('ort-2')
  })
  it('builds an authorization URL that names no scope, because the token inherits the user', () => {
    const url = new URL(authorizeUrl({ authorizationEndpoint: 'https://auth/authorize', tokenEndpoint: 'https://auth/token' },
      { clientId: 'cid', redirectUri: 'http://127.0.0.1:1/callback', challenge: 'ch', state: 'st' }))
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'code_challenge', 'code_challenge_method',
      'redirect_uri', 'response_type', 'state'])
    expect(url.searchParams.get('state')).toBe('st')
  })
  it('hands the whole URL to the browser, so every query parameter survives on Windows too', () => {
    // `cmd /c start "" <url>` splits on `&`: the browser saw only `?response_type=code` and answered
    // "invalid client_id or redirect_uri". The command carries the URL as one argument instead.
    const url = authorizeUrl({ authorizationEndpoint: 'https://auth/authorize', tokenEndpoint: 'https://auth/token' },
      { clientId: 'cid', redirectUri: 'http://127.0.0.1:1/callback', challenge: 'ch', state: 'st' })
    const [command, args] = browserCommand(url)
    expect(command).not.toBe('cmd')
    expect(args.at(-1)).toBe(url)
    expect(args.join(' ')).not.toContain('start')
    if (process.platform === 'win32') expect(command).toBe('rundll32')
  })
})
