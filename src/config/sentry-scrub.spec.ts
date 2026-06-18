import { scrubSentryEvent } from './sentry-scrub';

describe('scrubSentryEvent', () => {
  it('drops the request body and query string', () => {
    const e = scrubSentryEvent({
      request: { data: { password: 'x' }, query_string: 'token=abc' },
    });
    expect(e.request?.data).toBeUndefined();
    expect(e.request?.query_string).toBeUndefined();
  });
  it('redacts authorization and cookie headers, keeps others', () => {
    const e = scrubSentryEvent({
      request: {
        headers: {
          authorization: 'Bearer x',
          cookie: 'a=b',
          'user-agent': 'k6',
        },
      },
    });
    expect(e.request?.headers).toEqual({ 'user-agent': 'k6' });
  });
  it('is a no-op when there is no request', () => {
    expect(scrubSentryEvent({})).toEqual({});
  });
});
