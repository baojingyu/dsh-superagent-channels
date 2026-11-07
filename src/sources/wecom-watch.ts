/** WeCom source plugin entry: registers the kind; its callback route is mounted by the runtime from `handleWebhook`. */
import type { Context } from '@deepseek-ai/cordis'
import { wecomKind } from './chat/wecom/kind.ts'

export const kind = wecomKind
export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']

export function apply(ctx: Context): void {
  // WeCom delivers inbound messages by a signed, encrypted HTTP callback, not a loop: `handleWebhook` in
  // `./chat/wecom/webhook.ts` verifies, decrypts, and de-duplicates one request. The runtime mounts that handler on the
  // management server's public route; this entry only registers the kind (app/http.ts is out of this task's scope).
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind), 'wecom: source kind')
}
