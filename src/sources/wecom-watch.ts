/**
 * WeCom source plugin entry: registers the kind and mounts its signed callback route. WeCom delivers inbound messages by an
 * HTTP callback, not a loop, so this entry owns both: `handleWebhook` verifies, decrypts and de-duplicates one request, and
 * the route turns each event into a Trigger on this kind's SourceContext. The route is public by design (WeCom signs it);
 * ops points the application's receive URL at `<public origin>/wecom/<instance>`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DeliveredRing } from './chat/dedupe.ts'
import { sourceContext } from './host.ts'
import { wecomKind, wecomTriggerOf } from './chat/wecom/kind.ts'
import { handleWebhook } from './chat/wecom/webhook.ts'

export const kind = wecomKind
export const name = 'dsh-superagent-multi-channel-wecom'
export const inject = ['orchestrator', 'webServer']

/** Reads one callback body as UTF-8 text, with a ceiling so a stranger cannot stream unbounded bytes into the process. */
async function bodyOf(request: IncomingMessage, limit = 1_000_000): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind), 'wecom: source kind')
  const rings = new Map<string, DeliveredRing>()
  const ringFor = (instance: string): DeliveredRing => {
    const existing = rings.get(instance)
    if (existing) return existing
    const created = new DeliveredRing()
    rings.set(instance, created)
    return created
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/wecom',
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const instance = decodeURIComponent(url.pathname.replace(/^\/wecom\/?/, '').split('/')[0] ?? '')
      const registered = ctx.orchestrator.sources.instances().find(item => item.id === instance)
      const config = registered?.config as (Record<string, unknown> | undefined)
      if (!instance || !config || typeof config.corpId !== 'string') { response.writeHead(404); response.end(); return }
      const query = Object.fromEntries(url.searchParams.entries())
      const body = request.method === 'POST' ? await bodyOf(request) : undefined
      if (request.method === 'POST' && body === undefined) { response.writeHead(413); response.end(); return }
      const outcome = handleWebhook({ query, ...(body === undefined ? {} : { body }) }, {
        token: String(config.token ?? ''), encodingAesKey: String(config.encodingAesKey ?? ''),
        ...typeof config.encodingAesKeyFile === 'string' && config.encodingAesKeyFile ? { encodingAesKeyFile: config.encodingAesKeyFile } : {},
        corpId: config.corpId, instance }, ringFor(instance))
      if (!outcome.ok) { response.writeHead(403); response.end(); return }
      const source = sourceContext(ctx.orchestrator, wecomKind)
      for (const event of outcome.events) await source.receive(wecomTriggerOf(event, instance))
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(outcome.reply ?? 'success')
    },
  }), 'wecom: callback route')
}
