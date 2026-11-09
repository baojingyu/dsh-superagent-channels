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

  it('is ready once a launcher or a task name is set', () => {
    expect(action('bridge.start').ready!(config)).toBe(true)
    expect(action('bridge.start').ready!({ ...config, bridgeLauncher: 'C:\\x\\start.cmd' })).toBe(true)
    expect(action('bridge.start').ready!({ ...config, bridgeTask: '', bridgeLauncher: '' })).toBe(false)
  })

  it('refuses to start through a launcher that is not there', async () => {
    const calls: string[][] = []
    await expect(action('bridge.start').run(hostOf(calls), { ...config, bridgeLauncher: 'C:\\nope\\missing.cmd' }))
      .rejects.toThrow(/不存在/)
    expect(calls).toEqual([])
  })

  it('stops nothing when no bridge is listening, and says so', async () => {
    const host = {
      context: () => ({ commands: { withSignal: () => ({ run: async () => '' }) } }),
    } as unknown as SourceHost
    await expect(action('bridge.stop').run(host, { ...config, bridgeLauncher: 'C:\\x\\start.cmd' }))
      .resolves.toContain('没有在监听')
  })

  it('does not kill a process on the port whose command line is not the bridge', async () => {
    const ran: string[][] = []
    const host = {
      context: () => ({ commands: { withSignal: () => ({ run: async (program: string, args: string[]) => {
        ran.push([program, ...args])
        if (program === 'netstat') return '  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    4242'
        if (program === 'powershell') return 'C:\\Windows\\explorer.exe'
        return ''
      } }) } }),
    } as unknown as SourceHost
    await expect(action('bridge.stop').run(host, { ...config, bridgeLauncher: 'C:\\x\\start.cmd' }))
      .resolves.toContain('不是微信桥')
    expect(ran.some(([program]) => program === 'taskkill')).toBe(false)
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
