import { storableRow, UNSTORABLE_BODY } from './audit.service';

describe('storableRow', () => {
  const entry = {
    userId: 'u1',
    userRole: 'ADMIN',
    method: 'POST',
    path: '/v1/partners/%00?q=\ud800',
    params: { id: 'a\u0000b' },
    body: { name: 'x\ud800', password: 'kept-as-is' },
    statusCode: 400,
    durationMs: 3,
    ip: '127.0.0.1',
    requestId: 'r1',
    clientRequestId: null,
    entityId: null,
  };

  it('makes every caller-derived string storable, keeping the row fields', () => {
    expect(storableRow(entry)).toEqual({
      ...entry,
      path: '/v1/partners/%00?q=\ufffd',
      params: { id: 'ab' },
      // no redaction here (the body was already sanitized by its builder)
      body: { name: 'x\ufffd', password: 'kept-as-is' },
    });
  });

  it('stores {} for a missing params / body', () => {
    const row = storableRow({ ...entry, params: null, body: undefined });
    expect(row.params).toEqual({});
    expect(row.body).toEqual({});
  });

  it('the fallback body is a plain marker object', () => {
    expect(UNSTORABLE_BODY).toEqual({ _unstorable: true });
  });
});
