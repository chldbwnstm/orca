import { describe, expect, it } from 'vitest'
import { buildMoaConsortiumPrompt } from './moa-consortium-prompt'

describe('buildMoaConsortiumPrompt', () => {
  it('emits the skill tab-seat form with titles and exact tab ids', () => {
    const prompt = buildMoaConsortiumPrompt({
      seats: [
        { title: 'Fably', tabId: 'tab-1' },
        { title: 'Grokkie', tabId: 'tab-2' }
      ],
      problem: 'Should retries use exponential backoff or a queue?'
    })
    expect(prompt).toBe(
      '/moa tabs:"Fably","Grokkie" tab-ids:"tab-1","tab-2" Should retries use exponential backoff or a queue?'
    )
  })

  it('strips agent glyphs, newlines, and double quotes from seat names', () => {
    const prompt = buildMoaConsortiumPrompt({
      seats: [
        { title: '◐ Deep "review"\nrunner', tabId: 't1' },
        { title: '   ', tabId: 't2' }
      ],
      problem: '  trim me  '
    })
    expect(
      prompt.startsWith(`/moa tabs:"Deep 'review' runner","untitled" tab-ids:"t1","t2" trim me`)
    ).toBe(true)
    expect(prompt.endsWith('trim me')).toBe(true)
  })

  it('keeps a multi-line problem statement after the seat list', () => {
    const prompt = buildMoaConsortiumPrompt({
      seats: [{ title: 'A', tabId: 'a' }],
      problem: 'line one\nline two'
    })
    expect(prompt).toBe('/moa tabs:"A" tab-ids:"a" line one\nline two')
  })
})
