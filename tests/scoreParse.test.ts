/**
 * Model-reply parsing (SPEC §8.6). The 360M model wraps JSON in markdown, adds
 * prose, or cuts the reply short, so these shapes must still yield a score
 * instead of the default 5.
 */
import { describe, expect, it } from 'vitest';
import { parseScore, stripMarkdown } from '../src/pipeline/scoring';

describe('parseScore: real-world model replies', () => {
  it('strips a ```json fence with prose before and after', () => {
    const raw = 'Here is my rating:\n```json\n{"score": 8, "reason": "Clear hook and payoff"}\n```\nLet me know!';
    expect(parseScore(raw)).toEqual({ score: 8, reason: 'Clear hook and payoff' });
  });

  it('strips stray backticks around the JSON', () => {
    expect(parseScore('`{"score": 6, "reason": "Decent"}`')?.score).toBe(6);
  });

  it('reads a score written as "7/10" or "7 out of 10"', () => {
    expect(parseScore('{"score": "7/10", "reason": "ok"}')?.score).toBe(7);
    expect(parseScore('{"score": "9 out of 10", "reason": "ok"}')?.score).toBe(9);
    expect(parseScore('Overall I would give it 4/10.')?.score).toBe(4);
  });

  it('accepts "rating" and "Score" keys as well as "score"', () => {
    expect(parseScore('{"rating": 8, "reason": "x"}')?.score).toBe(8);
    expect(parseScore('{"Score": 3, "Reason": "x"}')?.score).toBe(3);
  });

  it('repairs a trailing comma', () => {
    expect(parseScore('{"score": 7, "reason": "good",}')?.score).toBe(7);
  });

  it('repairs single-quoted JSON', () => {
    expect(parseScore("{'score': 6, 'reason': 'fine'}")?.score).toBe(6);
  });

  it('reads a reply cut off before the closing brace', () => {
    const r = parseScore('{"score": 8, "reason": "Strong opening line and a');
    expect(r?.score).toBe(8);
  });

  it('reads bare key/value text with no braces', () => {
    expect(parseScore('score: 5\nreason: solid setup')?.score).toBe(5);
  });

  it('still returns null when the reply has no number at all', () => {
    expect(parseScore('This clip is excellent, I would share it.')).toBeNull();
    expect(parseScore('{"score": "high"}')).toBeNull();
  });
});

describe('stripMarkdown', () => {
  it('removes fences and inline backticks, keeps the content', () => {
    expect(stripMarkdown('```json\n{"a":1}\n```')).toBe('\n{"a":1}\n');
    expect(stripMarkdown('`x`')).toBe('x');
  });
});
