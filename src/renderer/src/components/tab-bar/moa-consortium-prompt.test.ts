import { describe, expect, it } from 'vitest'
import { buildMoaConsortiumPrompt } from './moa-consortium-prompt'

describe('buildMoaConsortiumPrompt', () => {
  it('emits the skill tab-seat form with unquoted titles and exact tab ids', () => {
    const prompt = buildMoaConsortiumPrompt({
      seats: [
        { title: 'Fably', tabId: 'tab-1' },
        { title: 'Grokkie', tabId: 'tab-2' }
      ],
      problem: 'Should retries use exponential backoff or a queue?'
    })
    expect(prompt).toBe(
      '/moa tabs:Fably|Grokkie tab-ids:tab-1,tab-2 Should retries use exponential backoff or a queue?'
    )
  })

  it('strips agent glyphs, separators, quotes, and newlines from seat names', () => {
    const prompt = buildMoaConsortiumPrompt({
      seats: [
        { title: '◐ Deep "review" | runner\nB', tabId: 't1' },
        { title: '   ', tabId: 't2' }
      ],
      problem: '  trim me  '
    })
    expect(prompt).toBe('/moa tabs:Deep review runner B|untitled tab-ids:t1,t2 trim me')
  })

  it('folds a multi-line problem statement onto the argv line', () => {
    const prompt = buildMoaConsortiumPrompt({
      seats: [{ title: 'A', tabId: 'a' }],
      problem: 'line one\nline two'
    })
    expect(prompt).toBe('/moa tabs:A tab-ids:a line one line two')
  })
})
