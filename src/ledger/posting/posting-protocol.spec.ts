import { PreparedPosting, PreparedReversal } from './posting.service';

// The real constructors require the module-private PROTOCOL_MINT symbol as the
// first arg, so they cannot be called normally from outside the module. Cast to
// a loose constructor to exercise the runtime guard.
type AnyCtor = new (...args: unknown[]) => unknown;

describe('posting protocol tokens are mint-guarded', () => {
  it('PreparedPosting throws when constructed without the mint', () => {
    const Forge = PreparedPosting as unknown as AnyCtor;
    expect(() => new Forge('not-the-mint', {}, 'u1', 'p1', 2026)).toThrow(
      'PreparedPosting is internal',
    );
  });

  it('PreparedReversal throws when constructed without the mint', () => {
    const Forge = PreparedReversal as unknown as AnyCtor;
    expect(
      () => new Forge('not-the-mint', {}, 'u1', 'p1', 2026, new Date(), false),
    ).toThrow('PreparedReversal is internal');
  });
});
