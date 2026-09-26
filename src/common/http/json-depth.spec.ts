import { BadRequestException } from '@nestjs/common';
import { exceedsDepth, jsonDepthGuard, MAX_BODY_DEPTH } from './json-depth';

const nestArrays = (depth: number): unknown =>
  JSON.parse('['.repeat(depth) + ']'.repeat(depth));

describe('exceedsDepth', () => {
  it('scalars and empty bodies never exceed', () => {
    for (const v of [undefined, null, 1, 'x', true]) {
      expect(exceedsDepth(v, 1)).toBe(false);
    }
    expect(exceedsDepth({}, 1)).toBe(false);
  });

  it('counts the top-level container as depth 1', () => {
    expect(exceedsDepth({ a: 1 }, 1)).toBe(false);
    expect(exceedsDepth({ a: { b: 1 } }, 1)).toBe(true);
    expect(exceedsDepth({ a: [{ b: [1] }] }, 4)).toBe(false);
    expect(exceedsDepth({ a: [{ b: [1] }] }, 3)).toBe(true);
  });

  it('accepts exactly MAX_BODY_DEPTH, rejects one more', () => {
    expect(exceedsDepth(nestArrays(MAX_BODY_DEPTH), MAX_BODY_DEPTH)).toBe(
      false,
    );
    expect(exceedsDepth(nestArrays(MAX_BODY_DEPTH + 1), MAX_BODY_DEPTH)).toBe(
      true,
    );
  });

  it('handles a 20k-deep body without overflowing the stack', () => {
    expect(exceedsDepth(nestArrays(20_000), MAX_BODY_DEPTH)).toBe(true);
  });

  it('finds a deep branch next to shallow siblings', () => {
    expect(
      exceedsDepth({ a: 1, b: [1, 2], c: { d: nestArrays(40) } }, 32),
    ).toBe(true);
  });
});

describe('jsonDepthGuard', () => {
  it('passes a normal body through', () => {
    const next = jest.fn();
    jsonDepthGuard({ body: { lines: [{ qty: '1' }] } }, {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('forwards a 400 for an over-deep body', () => {
    const next = jest.fn();
    jsonDepthGuard({ body: nestArrays(100) }, {}, next);
    expect((next.mock.calls[0] as unknown[])[0]).toBeInstanceOf(
      BadRequestException,
    );
  });
});
