import { InvalidCharactersError } from '../errors/domain-errors';
import {
  containsInvalidCharacters,
  inputHygieneGuard,
  invalidCharactersLocation,
  pathHasInvalidCharacters,
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

describe('pathHasInvalidCharacters', () => {
  it('flags a %00 path segment, ignoring the query string', () => {
    expect(pathHasInvalidCharacters('/v1/partners/%00')).toBe(true);
    expect(pathHasInvalidCharacters('/v1/partners/ab%00cd/void')).toBe(true);
    expect(pathHasInvalidCharacters('/v1/partners?q=%00')).toBe(false);
  });

  it('accepts clean / percent-encoded UTF-8 paths and skips malformed encoding', () => {
    expect(pathHasInvalidCharacters('/v1/partners/3f2c')).toBe(false);
    expect(pathHasInvalidCharacters('/v1/x/%F0%9F%98%80')).toBe(false); // 😀
    expect(pathHasInvalidCharacters('/v1/x/%E0%A4%A')).toBe(false); // malformed
    expect(pathHasInvalidCharacters('/v1/x/%ED%A0%80')).toBe(false); // URIError
    expect(pathHasInvalidCharacters('')).toBe(false);
  });
});

describe('invalidCharactersLocation / inputHygieneGuard', () => {
  it('reports path, then query, then body', () => {
    expect(
      invalidCharactersLocation({
        originalUrl: '/v1/a/%00',
        query: { q: '\u0000' },
        body: { a: '\u0000' },
      }),
    ).toBe('path');
    expect(
      invalidCharactersLocation({ url: '/v1/a', query: { 'k\u0000': '1' } }),
    ).toBe('query');
    expect(
      invalidCharactersLocation({ url: '/v1/a', body: { a: '\ud800' } }),
    ).toBe('body');
    expect(
      invalidCharactersLocation({ url: '/v1/a', query: {}, body: { a: '😀' } }),
    ).toBeNull();
  });

  it('passes a clean request and rejects a bad one with a 400 InvalidCharactersError', () => {
    const next = jest.fn<void, [unknown?]>();
    inputHygieneGuard({ url: '/v1/a', body: { a: 'ok' } }, {}, next);
    expect(next).toHaveBeenCalledWith();
    next.mockClear();
    inputHygieneGuard({ url: '/v1/a', body: { a: 'x\u0000' } }, {}, next);
    const err = next.mock.calls[0][0] as InvalidCharactersError;
    expect(err).toBeInstanceOf(InvalidCharactersError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_CHARACTERS');
    expect(err.details).toEqual({ location: 'body' });
  });
});
