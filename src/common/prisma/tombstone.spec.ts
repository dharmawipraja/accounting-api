import { tombstoneValue } from './tombstone';

describe('tombstoneValue', () => {
  it('suffixes a code with #deleted-<id>', () => {
    expect(tombstoneValue('AR-1000', 'abc')).toBe('AR-1000#deleted-abc');
  });
  it('suffixes an email', () => {
    expect(tombstoneValue('user@example.com', 'u-1')).toBe(
      'user@example.com#deleted-u-1',
    );
  });
});
