import { moneyVariance, varianceLines } from './report-line';

describe('varianceLines', () => {
  it('unions both periods by code: current order first, comparative-only lines appended, missing side = 0', () => {
    const r = varianceLines(
      [
        { code: '4-1000', name: 'Sales', amount: '1000' },
        { code: '4-2000', name: 'Service', amount: '50' },
      ],
      [
        { code: '4-3000', name: 'Old line', amount: '70' },
        { code: '4-1000', name: 'Sales', amount: '400.5' },
      ],
    );
    expect(r).toEqual([
      {
        code: '4-1000',
        name: 'Sales',
        current: '1000.0000',
        comparative: '400.5000',
        variance: '599.5000',
      },
      {
        code: '4-2000',
        name: 'Service',
        current: '50.0000',
        comparative: '0.0000',
        variance: '50.0000',
      },
      {
        code: '4-3000',
        name: 'Old line',
        current: '0.0000',
        comparative: '70.0000',
        variance: '-70.0000',
      },
    ]);
  });

  it('keys by subtype + code, so synthetic equity lines (code "") stay distinct and carry their subtype', () => {
    const r = varianceLines(
      [
        { subtype: 'CURRENT_EARNINGS', code: '', name: 'Laba', amount: '10' },
        {
          subtype: 'UNCLOSED_PRIOR_EARNINGS',
          code: '',
          name: 'LD',
          amount: '5',
        },
      ],
      [{ subtype: 'CURRENT_EARNINGS', code: '', name: 'Laba', amount: '4' }],
    );
    expect(r.map((l) => [l.subtype, l.variance])).toEqual([
      ['CURRENT_EARNINGS', '6.0000'],
      ['UNCLOSED_PRIOR_EARNINGS', '5.0000'],
    ]);
  });
});

describe('moneyVariance', () => {
  it('subtracts comparative from current for the given keys only', () => {
    expect(
      moneyVariance({ a: '10', b: '-2' }, { a: '15.25', b: '-2' }, [
        'a',
        'b',
      ] as const),
    ).toEqual({ a: '-5.2500', b: '0.0000' });
  });
});
