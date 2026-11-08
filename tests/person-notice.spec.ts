/** The one line a person receives when their message is not taken up. */
import { describe, expect, it } from 'vitest'
import { personNotice, said } from '../src/core/reasons.ts'

describe('personNotice', () => {
  it('names the reason a person can act on', () => {
    expect(personNotice({ code: 'senderNotMember' })).toContain('允许名单')
    expect(personNotice([{ code: 'said', values: { text: 'test' } }])).toContain('没看出')
    expect(personNotice({ code: 'startedTicket' })).toContain('已经有一个工单')
    expect(personNotice({ code: 'stopUnknown' })).toContain('没有对应的工单')
    expect(personNotice({ code: 'directionUnsettled' })).toContain('方向')
    expect(personNotice({ code: 'timeout' })).toContain('超时')
  })

  it('still answers when the code is one it does not know, or there is none', () => {
    expect(personNotice(undefined)).toBe('这条我没有接。')
    expect(personNotice(said('whatever'))).toContain('没看出')
    expect(personNotice({ code: 'somethingNew' })).toBe('这条我没有接。')
  })
})
