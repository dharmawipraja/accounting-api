import { hasInvalidCharacters, toStorableString } from './unicode-hygiene';

describe('hasInvalidCharacters', () => {
  it('flags a lone high / lone low surrogate, a reversed pair and U+0000', () => {
    for (const s of [
      '\ud800',
      'a\ud800b',
      'end\udbff',
      '\udc00start',
      'x\ude00\ud83dy', // low before high: both lone
      'a\u0000b',
      '\u0000',
    ]) {
      expect(hasInvalidCharacters(s)).toBe(true);
    }
  });

  it('accepts well-formed text: emoji pairs, ZWJ sequences, flags, CJK, Indonesian, other controls', () => {
    for (const s of [
      '',
      'PT Kopi Nusantara',
      'Jl. Jend. Sudirman Kav. 52-53, Kebayoran Baru',
      'café Ñandú — “quotes” • 1½',
      '😀',
      '👨‍👩‍👧 🇮🇩 ☕',
      '日本語 한국어 中文 𠜎', // 𠜎 is an astral CJK ideograph (a pair)
      'tab\tnewline\n\u0001',
      '\ufffd',
    ]) {
      expect(hasInvalidCharacters(s)).toBe(false);
    }
  });
});

describe('toStorableString', () => {
  it('strips U+0000 and replaces each lone surrogate with U+FFFD', () => {
    expect(toStorableString('a\u0000b\u0000')).toBe('ab');
    expect(toStorableString('a\ud800b')).toBe('a\ufffdb');
    expect(toStorableString('x\ude00\ud83dy')).toBe('x\ufffd\ufffdy');
    // halves separated by a NUL are each lone: never glued into a pair
    expect(toStorableString('\ud800\u0000\udc00')).toBe('\ufffd\ufffd');
  });

  it('returns well-formed text unchanged (same string)', () => {
    const s = 'PT Kopi 😀 👨‍👩‍👧 日本';
    expect(toStorableString(s)).toBe(s);
  });
});

describe('isWellFormed/toWellFormed vs the former lone-surrogate regexes', () => {
  // The pre-ES2024 implementation, kept as an equivalence oracle.
  const LONE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const oldHas = (s: string) => s.includes('\u0000') || LONE.test(s);
  const oldFix = (s: string) =>
    oldHas(s)
      ? s
          .replace(new RegExp(LONE.source, 'g'), '\ufffd')
          .split('\u0000')
          .join('')
      : s;

  it('agrees on every string of length 0..5 over {a, NUL, hi/lo surrogate range edges}', () => {
    const alphabet = ['a', '\u0000', '\ud800', '\udbff', '\udc00', '\udfff'];
    let layer = [''];
    for (let len = 0; len <= 5; len++) {
      for (const s of layer) {
        expect(hasInvalidCharacters(s)).toBe(oldHas(s));
        expect(toStorableString(s)).toBe(oldFix(s));
      }
      layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    }
  });
});
