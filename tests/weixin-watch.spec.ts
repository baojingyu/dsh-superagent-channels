/** weixin-watch: the listen set it pushes to the backend each round, and what it reports back about it. */
import { describe, expect, it } from 'vitest'
import type { BridgeClient, BridgeListenResult } from '../src/sources/chat/weixin/bridge.ts'
import { reconcileListen } from '../src/sources/weixin-watch.ts'

/** A bridge stub that records every `/listen` call, so a test can prove the call was made or skipped. */
function stub(result: BridgeListenResult = { listening: [], added: [], removed: [], failed: [] }, calls: string[][] = []): BridgeClient {
  return {
    async health() { return { ok: true, available: true } },
    async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
    async rooms() { return [] },
    async members() { return [] },
    async messages() { return { events: [], next: '' } },
    async send() { return { msgId: 'srv-1', deduped: false } },
    async listen(rooms) { calls.push([...rooms]); return result },
  }
}

const rooms = [{ id: 'wxname_aa', name: '研发-交付群' }, { id: 'wxname_bb', name: '运维群' }]

describe('reconcileListen', () => {
  it('sends the configured ids and reports what the backend confirmed it watches', async () => {
    const calls: string[][] = []
    const bridge = stub({ listening: rooms, added: ['研发-交付群'], removed: [], failed: [] }, calls)
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 2, unresolved: [] })
    // The id is what the configuration holds; the sidecar is what resolves it to a display name.
    expect(calls).toEqual([['wxname_aa', 'wxname_bb']])
  })

  it('names the chats the backend could not resolve, instead of counting them as watched', async () => {
    const bridge = stub({ listening: [rooms[0]!], added: [], removed: [], failed: [{ room: 'wxname_bb', detail: 'no such chat' }] })
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 1, unresolved: ['wxname_bb'] })
  })

  it('does nothing when no chat is configured, so a sidecar someone configured on its own is left alone', async () => {
    const calls: string[][] = []
    await expect(reconcileListen(stub(undefined, calls), [])).resolves.toEqual({ watching: 0, unresolved: [] })
    expect(calls).toEqual([])
  })

  it('does nothing for a backend that cannot change its listen set at runtime', async () => {
    const bridge: BridgeClient = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages() { return { events: [], next: '' } },
      async send() { return { msgId: 'srv-1', deduped: false } },
    }
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 0, unresolved: [] })
  })
})
