import { sanitize, toStorableJson } from './audit-sanitize';

describe('sanitize (audit body)', () => {
  it('redacts sensitive keys recursively', () => {
    expect(
      sanitize({ a: 1, password: 'p', n: [{ refreshToken: 't', ok: 'x' }] }),
    ).toEqual({
      a: 1,
      password: '[REDACTED]',
      n: [{ refreshToken: '[REDACTED]', ok: 'x' }],
    });
  });

  it('makes strings storable: lone surrogates → U+FFFD, U+0000 stripped (values and keys)', () => {
    const out = sanitize({
      name: 'Bad \ud800 name',
      note: 'a\u0000b',
      ['k\u0000\udc00']: ['x\ud83d'],
    });
    expect(out).toEqual({
      name: 'Bad \ufffd name',
      note: 'ab',
      ['k\ufffd']: ['x\ufffd'],
    });
    // jsonb-safe: the JSON text has no lone-surrogate or \u0000 escape
    expect(JSON.stringify(out)).not.toMatch(/\\u(d[89a-f][0-9a-f]{2}|0000)/i);
  });

  it('keeps __proto__ / constructor / prototype keys as plain data (null-prototype objects)', () => {
    const body = JSON.parse(
      '{"__proto__":{"polluted":1},"constructor":"c","prototype":{"x":2}}',
    ) as Record<string, unknown>;
    const out = sanitize(body) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.keys(out)).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(JSON.parse(JSON.stringify(out))).toEqual(body);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps emoji / multilingual text and scalars unchanged', () => {
    const body = { name: 'PT Kopi 😀 👨‍👩‍👧 日本', n: 1, b: true, z: null };
    expect(sanitize(body)).toEqual(body);
    expect(sanitize('x')).toBe('x');
    expect(sanitize(undefined)).toBeUndefined();
  });
});

describe('toStorableJson', () => {
  it('repairs strings but never redacts', () => {
    expect(toStorableJson({ token: 'a\u0000', id: '\ud800' })).toEqual({
      token: 'a',
      id: '\ufffd',
    });
    expect(toStorableJson('{"a":"\ud800"}')).toBe('{"a":"\ufffd"}');
  });
});
