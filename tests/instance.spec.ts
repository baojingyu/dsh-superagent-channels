import { describe, expect, it } from 'vitest'
import { instanceId, kindOf, storesKind } from '../src/sources/instance.ts'
import { SourceInstanceSchema } from '../src/policy.ts'

describe('instanceId', () => {
  it('joins the kind and the slug of a named instance', () => {
    expect(instanceId('weixin', 'ops')).toBe('weixin-ops')
  })
  it('is the kind itself for the default instance', () => {
    expect(instanceId('github')).toBe('github')
  })
})

describe('kindOf', () => {
  it('falls back to the id when no kind is stored', () => {
    expect(kindOf(undefined, 'github')).toBe('github')
    expect(kindOf({}, 'github')).toBe('github')
  })
  it('reads the stored kind of an instance whose id differs from it', () => {
    expect(kindOf({ kind: 'wecom' }, 'wecom-hr')).toBe('wecom')
  })
})

describe('storesKind', () => {
  it('stores the kind of an instance whose id differs from it', () => {
    expect(storesKind({ id: 'wecom-hr', kind: 'wecom' })).toBe(true)
  })
  it('omits the kind of an instance whose id is the kind', () => {
    expect(storesKind({ id: 'github', kind: 'github' })).toBe(false)
  })
})

describe('SourceInstanceSchema', () => {
  it('parses a stored instance without a kind', () => {
    expect(SourceInstanceSchema.parse({ enabled: true, config: {} })).toEqual({ enabled: true, config: {} })
  })
  it('parses a stored instance with a kind', () => {
    expect(SourceInstanceSchema.parse({ kind: 'wecom', enabled: true, config: {} })).toEqual({ kind: 'wecom', enabled: true, config: {} })
  })
  it('rejects unknown keys', () => {
    expect(SourceInstanceSchema.safeParse({ enabled: true, config: {}, extra: 1 }).success).toBe(false)
  })
})