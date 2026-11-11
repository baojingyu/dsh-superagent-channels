/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, TicketOutcome, Trigger } from './model.ts'
import type { OutboundFile, ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string
      files?: OutboundFile[] }
/** The first `max` characters of `text`, cut at a character rather than into a word. */
const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
/** How an ending reads at the start of the line a person receives. */
const OUTCOME_LEAD: Readonly<Record<TicketOutcome, string>> = {
  completed: '已完成：', merged: '已合并：', closed: '已关闭（未合并）：', dropped: '已放弃：', stopped: '已停止：',
}
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  /**
   * Queue a ticket's open question for a person to the conversation that must hear it, so the Source shows the question
   * even when the main Session never sends an attention reply.
   *
   * A question needs the main Session's `orchestrator_reply`; when that call does not come - a model that asks in its own
   * chat instead - a work item shows nothing and the person never learns that work waits on them. So the question is
   * queued here, under the same id an attention reply would use: whichever is queued first wins, and the question is
   * never posted twice.
   *
   * A ticket a machine asked for is skipped: there is no person to tell.
   */
  announceAttention(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    const attention = ticket?.attention
    if (!ticket || !attention) return
    const origin = this.source(ticket)
    if (!origin?.human) return
    const id = key('attention-reply', attention.id)
    if (this.options.outbox.status(id)) return
    const asker = attention.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = asker?.channel ?? this.sourceChannel(ticket)
    if (!channel) return
    try {
      this.options.outbox.send({ id, channel, text: attention.question, kind: 'reply', ticketId })
    } catch {
      /* A channel cap that refuses this text leaves the main Session's own attention reply as the fallback. */
    }
  }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {},
      ...request.files?.length ? { files: request.files } : {} })
    // The conversation hears the result from here on; a ticket that ends later keeps quiet about it.
    if (request.purpose === 'result' && ticket) {
      ticket.notified = true
      this.repo.tickets.save(ticket)
    }
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /**
   * Tell the conversation a ticket started in how it ended, unless that already happened.
   *
   * The Engine sends the acceptance itself but a result needs the main Session's `orchestrator_reply`; when that call does not
   * come - a model that answers in its own chat instead - the Source hears nothing at all, and a work item shows an acceptance
   * comment and then silence for ever. So an ending speaks here, with the worker's own ready summary as the body.
   *
   * A ticket a machine asked for is skipped: there is no person to tell. A `stopped` ticket is skipped too, because whoever
   * stopped it knows, and the panel's stop must not reach into somebody's conversation.
   */
  announceEnd(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket?.ended || ticket.notified) return
    const outcome = ticket.ended.outcome
    if (outcome === 'stopped') return
    const origin = this.source(ticket)
    if (!origin?.human) return
    const channel = this.sourceChannel(ticket)
    if (!channel) return
    const report = latestAssignment(ticket)?.report
    const summary = report?.summary.trim() ?? ''
    const lead = OUTCOME_LEAD[outcome]
    // A channel may cap its messages (Feishu's IM limit throws on a long one), so the full summary is tried first and a short
    // line second. Neither may break the report that is ending the ticket, which is why both sit in a try.
    const candidates = [...new Set([summary ? lead + clip(summary, 1_000) : lead.trimEnd(), lead + clip(summary, 80)])]
    for (const text of candidates) {
      try {
        this.options.outbox.send({ id: key('outcome', ticketId), channel, text, kind: 'reply', ticketId })
        ticket.notified = true
        this.repo.tickets.save(ticket)
        return
      } catch {
        /* The next candidate is shorter; if none fits, the channel stays without a notice. */
      }
    }
    this.emit('result.announceFailed', { ticketId, outcome, source: channel.source })
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
