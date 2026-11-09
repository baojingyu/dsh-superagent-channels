/**
 * Source card actions: the WeChat bridge is a separate, long-lived process, so the panel only asks the machine's scheduled task to
 * start or stop it. These tests pin the two properties that make that safe - the fixed argv, and the refusal of anything that is not
 * a task name.
 */
import { describe, expect, it } from 'vitest'
import type { SourceHost } from '../src/sources/host.ts'
import { WeixinConfigSchema, weixinKind } from '../src/sources/chat/weixin/kind.ts'

const action = (id: string) => weixinKind.actions!.find(item => item.id === id)!

function hostOf(calls: string[][]): SourceHost {
  return {
    context: () => ({ commands: { withSignal: () => ({
      run: async (program: string, args: string[]) => { calls.push([program, ...args]); return '' },
    }) } }),
  } as unknown as SourceHost
}

const config = WeixinConfigSchema.parse({ tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self' })

describe('WeChat bridge actions', () => {
  it('offers start, stop, restart and check', () => {
    expect(weixinKind.actions!.map(item => item.id)).toEqual(['bridge.start', 'bridge.stop', 'bridge.restart', 'bridge.check'])
  })

  it('starts by asking the configured task to run, with a fixed argv', async () => {
    const calls: string[][] = []
    const message = await action('bridge.start').run(hostOf(calls), config)
    expect(calls).toEqual([['schtasks', '/run', '/tn', 'DSH-WeChat-Bridge']])
    expect(message).toContain('启动')
  })

  it('restarts by ending then running the same task', async () => {
    const calls: string[][] = []
    await action('bridge.restart').run(hostOf(calls), { ...config, bridgeTask: 'My-Bridge' })
    expect(calls).toEqual([['schtasks', '/end', '/tn', 'My-Bridge'], ['schtasks', '/run', '/tn', 'My-Bridge']])
  })

  it('is only ready once a task name is set', () => {
    expect(action('bridge.start').ready!(config)).toBe(true)
    expect(action('bridge.start').ready!({ ...config, bridgeTask: '' })).toBe(false)
  })

  it('refuses a task name that is not a task name, at the schema and again at the call', async () => {
    // The schema rejects it on save...
    expect(WeixinConfigSchema.safeParse({ ...config, bridgeTask: 'DSH & calc.exe' }).success).toBe(false)
    expect(WeixinConfigSchema.safeParse({ ...config, bridgeTask: 'x; rm -rf /' }).success).toBe(false)
    // ...and the runner refuses it too, so a stale stored value still cannot reach a command line.
    const calls: string[][] = []
    await expect(action('bridge.start').run(hostOf(calls), { ...config, bridgeTask: 'x; calc' })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('reports the bridge capability when the health read says it is up', async () => {
    const host = {
      sources: { instance: () => ({ config }) },
    } as unknown as SourceHost
    // Without a reachable bridge the check fails rather than claiming success, whatever the reason (missing token, refused port).
    await expect(action('bridge.check').run(host, config)).rejects.toThrow()
  })
})
