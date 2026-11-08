/**
 * Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
 * Policy gates and source scopes may also emit their own literal reason codes.
 */
export const REASONS = {
  said: '{text}',
  timeout: 'Assessment timed out',
  policyChanged: 'Policy changed during assessment',
  noAdmissible: 'No admissible trigger',
  startedTicket: 'Already started ticket {ticket}',
  acceptedBefore: 'Trigger {trigger} was accepted before',
  routed: 'Routed to ticket {ticket}',
  explicitRouted: 'Explicit request from an allowed sender routed by the orchestrator',
  humanStop: 'Human asked to stop',
  legacyImport: 'Imported from the pre-domain-model task record',
  forwarded: 'Forwarded to the worker of the Ticket already on this Thread',
  senderNotMember: 'The sender is not on the Source\'s list',
  retried: 'Retried by a person',
  hostRestarted: 'dsh-superagent restarted',
  stopUnknown: 'Stop target is unknown or already ended',
  stopNotExplicit: 'A stop needs an explicit request from a sender on the list',
  directionUnsettled: 'Implementation intent or target direction is not established, or a product/design decision is still required',
  noRuleMatched: 'No enabled admission rule matched',
  ignoredFromCard: 'Ignored from its card, without a rule assessment',
  observed: 'Observe mode: would accept ({text})',
} as const
export type ReasonCode = keyof typeof REASONS
/** Reason code and template values; `triggerId` identifies the trigger in a batch that the reason applies to. */
export interface Reason { code: ReasonCode | (string & {}); values?: Record<string, string>; triggerId?: string }
export const said = (text: string): Reason => ({ code: 'said', values: { text } })
/**
 * What to tell the person who wrote, in their own chat, when their message is not taken up. Short and concrete: they
 * asked for something and deserve to know it was not picked up, without reading a panel they may not be near.
 */
export function personNotice(reasons: readonly Reason[] | Reason | undefined): string {
  const first = [reasons ?? []].flat()[0]
  switch (first?.code) {
    case 'senderNotMember': return '这条我没有接：你的账号不在允许名单里。'
    case 'said': return '这条我没有接：没看出要我做什么。'
    case 'startedTicket': return '这条我没有接：已经有一个工单在处理了。'
    case 'stopUnknown': return '这条我没有接：没有对应的工单可以停。'
    case 'stopNotExplicit': return '这条我没有接：停止需要工单发起人明确说明。'
    case 'directionUnsettled': return '这条我没有接：方向还没定，需要先确认要不要动手。'
    case 'noRuleMatched': return '这条我没有接：没有匹配的准入规则。'
    case 'timeout': return '这条我没有接：判断超时了，请再发一次。'
    default: return '这条我没有接。'
  }
}
/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
export function reasonText(reasons: readonly Reason[] | Reason | undefined): string {
  return [reasons ?? []].flat().map(reason => {
    const template: string = REASONS[reason.code as ReasonCode] ?? reason.code
    const text = template.replace(/\{(\w+)\}/g, (match, name: string) => reason.values?.[name] ?? match)
    return reason.triggerId ? `${reason.triggerId}: ${text}` : text
  }).join('; ')
}
