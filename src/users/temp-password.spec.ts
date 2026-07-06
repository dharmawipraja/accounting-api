import { generateTempPassword, TEMP_PASSWORD_CHARSET } from './temp-password';

describe('generateTempPassword', () => {
  it('returns 16 chars drawn only from the unambiguous charset', () => {
    const pw = generateTempPassword();
    expect(pw).toHaveLength(16);
    for (const ch of pw) expect(TEMP_PASSWORD_CHARSET).toContain(ch);
  });
  it('excludes ambiguous characters', () => {
    for (const bad of ['0', 'O', '1', 'l', 'I']) {
      expect(TEMP_PASSWORD_CHARSET).not.toContain(bad);
    }
  });
  it('is not deterministic', () => {
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});
