import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Foo.Bar@Example.COM ')).toBe(
      'foo.bar@example.com',
    );
  });
});

describe('normalizeEmail (Unicode)', () => {
  it('NFC-normalizes so a decomposed and a precomposed address are one email', () => {
    const composed = 'josé@example.com';
    const decomposed = 'josé@example.com';
    expect(normalizeEmail(decomposed)).toBe(composed);
    expect(normalizeEmail(` JOSÉ@Example.com `)).toBe(composed);
  });
});
