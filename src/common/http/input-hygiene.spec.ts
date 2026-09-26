import { InvalidCharactersError } from '../errors/domain-errors';
import type { ExecutionContext } from '@nestjs/common';
import {
  containsInvalidCharacters,
  InputHygieneGuard,
  invalidCharactersLocation,
  type HygieneRequest,
} from './input-hygiene';

describe('containsInvalidCharacters', () => {
  it('finds a bad character in a string leaf, a nested key, or an array element', () => {
    expect(containsInvalidCharacters('a\u0000')).toBe(true);
    expect(containsInvalidCharacters({ a: { b: ['ok', 'x\ud800'] } })).toBe(
      true,
    );
    expect(containsInvalidCharacters({ lines: [{ 'k\u0000': 1 }] })).toBe(true);
    expect(containsInvalidCharacters([[{ '\udc00': null }]])).toBe(true);
  });

  it('accepts clean and non-string values (numbers, booleans, null, emoji)', () => {
    for (const v of [
      undefined,
      null,
      1,
      true,
      {},
      [],
      { name: 'PT Kopi 😀 👨‍👩‍👧', n: 1, ok: false, x: null, a: ['日本'] },
    ]) {
      expect(containsInvalidCharacters(v)).toBe(false);
    }
  });

  it('checks an own "__proto__" key parsed from JSON', () => {
    expect(
      containsInvalidCharacters(JSON.parse('{"__proto__":"\\u0000"}')),
    ).toBe(true);
  });

  it('is iterative: a 100k-deep structure does not overflow the stack', () => {
    const depth = 100_000;
    const deep: unknown = JSON.parse(
      '['.repeat(depth) + '"\\u0000"' + ']'.repeat(depth),
    );
    expect(containsInvalidCharacters(deep)).toBe(true);
  });
});

describe('invalidCharactersLocation / InputHygieneGuard', () => {
  it('reports a route param (as "path"), then query, then body', () => {
    expect(
      invalidCharactersLocation({
        params: { id: '\u0000' },
        query: { q: '\u0000' },
        body: { a: '\u0000' },
      }),
    ).toBe('path');
    expect(
      invalidCharactersLocation({ params: {}, query: { 'k\u0000': '1' } }),
    ).toBe('query');
    expect(
      invalidCharactersLocation({ params: {}, body: { a: '\ud800' } }),
    ).toBe('body');
    expect(
      invalidCharactersLocation({
        params: { id: '3f2c', name: 'Kopi 😀' },
        query: {},
        body: { a: '😀' },
      }),
    ).toBeNull();
    expect(invalidCharactersLocation({})).toBeNull();
  });

  const ctx = (req: HygieneRequest) =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  it('passes a clean request and rejects a bad one with a 400 InvalidCharactersError', () => {
    const guard = new InputHygieneGuard();
    expect(guard.canActivate(ctx({ params: {}, body: { a: 'ok' } }))).toBe(
      true,
    );
    let err: unknown;
    try {
      guard.canActivate(ctx({ params: {}, body: { a: 'x\u0000' } }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidCharactersError);
    const e = err as InvalidCharactersError;
    expect(e.status).toBe(400);
    expect(e.code).toBe('INVALID_CHARACTERS');
    expect(e.details).toEqual({ location: 'body' });
  });
});
