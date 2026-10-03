import { decodeGlCursor, encodeGlCursor } from './general-ledger.service';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('general-ledger cursor', () => {
  const c = { date: '2026-03-05', entryNumber: 42, entryId: 'e-1', lineNo: 2 };

  it('round-trips', () => {
    expect(decodeGlCursor(encodeGlCursor(c))).toEqual(c);
  });

  it.each([
    ['garbage', 'not-base64-json!'],
    ['wrong shape', b64('{"a":1}')],
    ['bad date', b64('["2026-02-30",1,"e",1]')],
    ['non-integer number', b64('["2026-01-01",1.5,"e",1]')],
    ['int4 overflow', b64('["2026-01-01",2147483648,"e",1]')],
    ['empty id', b64('["2026-01-01",1,"",1]')],
  ])('rejects %s with 422', (_label, token) => {
    expect(() => decodeGlCursor(token)).toThrow(
      expect.objectContaining({ status: 422 }) as Error,
    );
  });
});
