/**
 * Two page rules, held by a test so neither drifts: no Markdown markers in anything a person reads, and Source cards ordered
 * enabled first, then by English name A → Z.
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { orderSources } from '../src/client/source.tsx'
import { githubKind } from '../src/sources/github.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { weixinKind } from '../src/sources/chat/weixin/kind.ts'
import { gitlabKind } from '../src/sources/hosting/gitlab/kind.ts'
import { projexKind } from '../src/sources/work/projex/kind.ts'
import { dingtalkKind } from '../src/sources/chat/dingtalk/kind.ts'
import { wecomKind } from '../src/sources/chat/wecom/kind.ts'
import type { SourceKind } from '../src/sources/kind.ts'

const KINDS = [githubKind, feishuKind, weixinKind, gitlabKind, projexKind, dingtalkKind, wecomKind] as SourceKind<never>[]
/** Bold, italic, headings and bullet markers: the shapes a panel would show literally. */
const MARKDOWN = /\*\*|__|(^|\n)\s*#{1,6}\s|(^|\n)\s*[-*]\s/

function violations(text: string, where: string): string[] {
  return MARKDOWN.test(text) ? [`${where}: ${text.slice(0, 80)}`] : []
}

describe('no Markdown in user-facing copy', () => {
  it('holds for every string the panel shows', () => {
    const bad: string[] = []
    const both = (value: { zh: string; en: string } | undefined, where: string) => {
      if (!value) return
      bad.push(...violations(value.zh, `${where}.zh`), ...violations(value.en, `${where}.en`))
    }
    for (const kind of KINDS) {
      both(kind.title, `${kind.kind}.title`)
      both(kind.description, `${kind.kind}.description`)
      for (const field of kind.fields) {
        both(field.label, `${kind.kind}.${field.key}.label`)
        if (field.hint) both(field.hint, `${kind.kind}.${field.key}.hint`)
        for (const option of 'options' in field ? field.options ?? [] : []) both(option.label, `${kind.kind}.${field.key}.option`)
        for (const column of 'columns' in field ? field.columns ?? [] : []) both(column.label, `${kind.kind}.${field.key}.${column.key}`)
      }
      const policy = (kind as unknown as { policy?: { fields: { key: string; label: { zh: string; en: string }; hint?: { zh: string; en: string } }[];
        explicit: { zh: string; en: string }; warnings?(config: Record<string, unknown>, part: { allowed: unknown[] }): { zh: string; en: string }[];
        rows(config: Record<string, unknown>): { label: { zh: string; en: string } | string; note: { zh: string; en: string } }[] } }).policy
      if (!policy) continue
      both(policy.explicit, `${kind.kind}.policy.explicit`)
      for (const field of policy.fields) {
        both(field.label, `${kind.kind}.policy.${field.key}.label`)
        if (field.hint) both(field.hint, `${kind.kind}.policy.${field.key}.hint`)
      }
      for (const warning of policy.warnings?.({}, { allowed: [] }) ?? []) both(warning, `${kind.kind}.policy.warning`)
      for (const row of policy.rows({})) {
        if (typeof row.label !== 'string') both(row.label, `${kind.kind}.row.label`)
        both(row.note, `${kind.kind}.row.note`)
      }
    }
    expect(bad).toEqual([])
  })

  it('holds for both UI dictionaries', () => {
    const bad = [
      ...Object.entries(zh).flatMap(([key, text]) => violations(text, `zh.${key}`)),
      ...Object.entries(en).flatMap(([key, text]) => violations(text, `en.${key}`)),
    ]
    expect(bad).toEqual([])
  })
})

describe('Source cards order', () => {
  const card = (id: string, name: string, enabled: boolean) => ({ id, value: { enabled }, title: { zh: id, en: name } })

  it('puts enabled Sources first, then sorts each group by English name', () => {
    const ordered = orderSources([card('a', 'Zebra', false), card('b', 'alpha', true), card('c', 'Beta', false), card('d', 'Gamma', true)])
    expect(ordered.map(item => item.id)).toEqual(['b', 'd', 'c', 'a'])
  })

  it('leaves the input untouched', () => {
    const input = [card('a', 'Zebra', false), card('b', 'Alpha', true)]
    orderSources(input)
    expect(input.map(item => item.id)).toEqual(['a', 'b'])
  })
})
