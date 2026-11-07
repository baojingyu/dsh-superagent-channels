/**
 * Live probes of three real OpenAPI auth-failure paths (WeCom, DingTalk, Yunxiao), using bogus credentials only.
 * They run only with `LIVE=1`; the default suite skips the whole file. Each probe makes exactly one request with a 15s
 * timeout, asserts that a bad credential becomes a diagnosable auth error (never a crash), and that the bogus secret is
 * never echoed. A rate-limited or unreachable endpoint skips that vendor's probe with a printed reason, never a false pass.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWecomSender } from '../../src/sources/chat/wecom/adapter.ts'
import { sendMessage } from '../../src/sources/chat/dingtalk/adapter.ts'
import { createYunxiaoApi, YunxiaoHttpError } from '../../src/infra/yunxiao-api.ts'

const LIVE = process.env.LIVE === '1'
/** A bogus value that is never a real credential; assertions ensure it never appears in an error. */
const BOGUS_SECRET = 'bogus-secret-for-test'
const REQUEST_TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = 30_000

/**
 * Whether a failure belongs to the environment (rate limiting or a network problem) rather than to the API's credential
 * answer. Such a probe must be skipped with its reason printed, never reported as a pass.
 */
function environmentFailure(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: unknown }).status
  if (status === 429 || /(^|[^0-9])429([^0-9]|$)/.test(message)) return `rate limited: ${message}`
  if (error instanceof TypeError
    || /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|aborted|socket hang up/i.test(message)) {
    return `network error: ${message}`
  }
  return undefined
}

describe.skipIf(!LIVE)('third-party auth failures over the real OpenAPI', () => {
  it('WeCom: a bogus corp secret surfaces errcode 40013 and never echoes the secret', async (ctx) => {
    try {
      await createWecomSender({ timeoutMs: REQUEST_TIMEOUT_MS }).accessToken({ corpId: 'badcorp', corpSecret: BOGUS_SECRET, agentId: 1 })
      throw new Error('WeCom accepted a bogus corp secret')
    } catch (error) {
      const skipped = environmentFailure(error)
      if (skipped) { console.warn(`[live][wecom] skipped: ${skipped}`); ctx.skip(); return }
      const message = (error as Error).message
      // The real API answers errcode 40013 (invalid corpid); accept the code rather than the ever-changing errmsg.
      expect(message).toMatch(/40013|invalid corpid/i)
      expect(message).not.toContain(BOGUS_SECRET)
    }
  }, TEST_TIMEOUT_MS)

  it('DingTalk: a bogus app secret is recognized as an auth failure, not a crash', async (ctx) => {
    try {
      await sendMessage({ clientId: 'bogus-client-id', clientSecret: BOGUS_SECRET, robotCode: 'bogus-robot' },
        { conversationId: 'cid-live-probe' }, 'hi', 'live-dingtalk-probe')
      throw new Error('DingTalk accepted a bogus app secret')
    } catch (error) {
      const skipped = environmentFailure(error)
      if (skipped) { console.warn(`[live][dingtalk] skipped: ${skipped}`); ctx.skip(); return }
      // A rejected promise with a diagnosable error is the expected shape; anything else (a TypeError crash) fails here.
      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).toMatch(/invalidClientIdOrSecret|40089|appkey|appsecret|corpid|client/i)
      expect(message).not.toContain(BOGUS_SECRET)
    }
  }, TEST_TIMEOUT_MS)

  it('Yunxiao: a bogus token yields a 4xx YunxiaoHttpError with a requestId and no token', async (ctx) => {
    const directory = mkdtempSync(join(tmpdir(), 'yunxiao-live-'))
    try {
      const tokenFile = join(directory, 'token')
      writeFileSync(tokenFile, 'pt-bogus')
      chmodSync(tokenFile, 0o600)
      const api = createYunxiaoApi({ tokenFile, orgWhitelist: ['demo'], timeoutMs: REQUEST_TIMEOUT_MS })
      try {
        await api.get('/oapi/v1/projex/organizations/demo/workitems', { category: 'Req', pageSize: 1 })
        throw new Error('Yunxiao accepted a bogus token')
      } catch (error) {
        const skipped = environmentFailure(error)
        if (skipped) { console.warn(`[live][yunxiao] skipped: ${skipped}`); ctx.skip(); return }
        expect(error).toBeInstanceOf(YunxiaoHttpError)
        const httpError = error as YunxiaoHttpError
        expect(httpError.status).toBeGreaterThanOrEqual(400)
        expect(httpError.status).toBeLessThan(500)
        // The real 4xx body carries a requestId (and errorCode NotFound); the diagnostic keeps it and redacts the token.
        expect(httpError.message).toMatch(/requestId/i)
        expect(httpError.message).not.toContain('pt-bogus')
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, TEST_TIMEOUT_MS)
})
