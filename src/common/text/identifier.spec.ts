import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  hasFormatChars,
  hasFormatOrControlChars,
  normalizeDisplayName,
  normalizeIdentifierCode,
} from './identifier';
import { CreateAccountDto } from '../../ledger/accounts/dto/create-account.dto';
import { UpdateAccountDto } from '../../ledger/accounts/dto/update-account.dto';
import { CreateTaxCodeDto } from '../../tax/dto/create-tax-code.dto';
import { UpdateTaxCodeDto } from '../../tax/dto/update-tax-code.dto';
import { CreateBusinessPartnerDto } from '../../invoicing/dto/create-business-partner.dto';
import { UpdateBusinessPartnerDto } from '../../invoicing/dto/update-business-partner.dto';

describe('normalizeIdentifierCode', () => {
  it('NFKC-folds full-width letters and trims surrounding white space', () => {
    expect(normalizeIdentifierCode('  ＤＵＰ-１ \t')).toBe('DUP-1');
  });

  it('keeps the case and seeded chart codes unchanged', () => {
    expect(normalizeIdentifierCode('Kas-01')).toBe('Kas-01');
    expect(normalizeIdentifierCode('1-1000')).toBe('1-1000');
  });

  it('does NOT trim U+FEFF / U+200B (they are rejected, not silently dropped)', () => {
    expect(normalizeIdentifierCode('﻿DUP')).toBe('﻿DUP');
    expect(normalizeIdentifierCode('DUP​')).toBe('DUP​');
  });

  it('turns a white-space-only value into the empty string', () => {
    expect(normalizeIdentifierCode(' 　  ')).toBe('');
  });
});

describe('normalization is linear time (iter9 P1 ReDoS)', () => {
  // 'a' + N spaces + 'a': the old /^\p{White_Space}+|\p{White_Space}+$/gu
  // re-scanned the whole run from every interior space (O(N²): 200k chars
  // took seconds, ~1 MB minutes).
  const padded = (n: number) => `a${' '.repeat(n)}a`;
  const within = (ms: number, f: () => void) => {
    const t = process.hrtime.bigint();
    f();
    return Number(process.hrtime.bigint() - t) / 1e6 < ms;
  };

  it('trims a 200k-char interior-white-space string in < 100 ms', () => {
    expect(within(100, () => normalizeDisplayName(padded(200_000)))).toBe(true);
    expect(within(100, () => normalizeIdentifierCode(padded(200_000)))).toBe(
      true,
    );
    expect(normalizeDisplayName(`  ${padded(3)} \u3000`)).toBe(padded(3));
  });

  it('a ~1 MB white-space-padded name / code through the DTOs is rejected in < 100 ms', () => {
    const huge = padded(1_000_000);
    let r: { failed: string[] } = { failed: [] };
    expect(
      within(100, () => {
        r = validated(UpdateBusinessPartnerDto, { name: huge });
      }),
    ).toBe(true);
    expect(r.failed).toContain('name');
    expect(
      within(100, () => {
        r = validated(CreateAccountDto, { code: huge, parentCode: huge });
      }),
    ).toBe(true);
    expect(r.failed).toEqual(expect.arrayContaining(['code', 'parentCode']));
  });
});

describe('normalizeDisplayName', () => {
  it('trims but does not NFKC-fold or change the case', () => {
    expect(normalizeDisplayName('  PT Ｍaju Jaya  ')).toBe('PT Ｍaju Jaya');
  });

  it('leaves Indonesian names untouched', () => {
    expect(normalizeDisplayName('Kas & Setara Kas')).toBe('Kas & Setara Kas');
  });
});

describe('hasFormatOrControlChars / hasFormatChars', () => {
  it.each(['​', '‍', '﻿', '‮', '­'])('flags the format character %j', (ch) => {
    expect(hasFormatOrControlChars(`A${ch}B`)).toBe(true);
    expect(hasFormatChars(`A${ch}B`)).toBe(true);
  });

  it('flags control characters for codes but not for names', () => {
    expect(hasFormatOrControlChars('A\tB')).toBe(true);
    expect(hasFormatOrControlChars('A\u0085B')).toBe(true);
    expect(hasFormatChars('A\tB')).toBe(false);
  });

  it('names may keep the ZWJ of an emoji ZWJ sequence, not a ZWJ between letters', () => {
    expect(hasFormatChars('Keluarga 👨\u200D👩\u200D👧 🏳\uFE0F\u200D🌈')).toBe(
      false,
    );
    expect(hasFormatChars('A\u200DB')).toBe(true);
    expect(hasFormatChars('😀\u200D')).toBe(true);
    expect(hasFormatOrControlChars('👨\u200D👩')).toBe(true);
  });

  it('accepts ordinary ASCII, Indonesian and CJK text', () => {
    expect(hasFormatOrControlChars('1-1000')).toBe(false);
    expect(hasFormatOrControlChars('PPN-11')).toBe(false);
    expect(hasFormatChars('Pajak Pertambahan Nilai 株式会社 😀')).toBe(false);
  });
});

describe('invisible characters beyond Cf / Cc (iter9)', () => {
  // Default_Ignorable_Code_Point non-Cf characters render as nothing: combining
  // grapheme joiner, Hangul fillers, Khmer inherent vowels, Mongolian free
  // variation selectors, variation selectors, tag characters.
  const ignorable = [
    '\u034F',
    '\u115F',
    '\u1160',
    '\u3164',
    '\uFFA0',
    '\u17B4',
    '\u17B5',
    '\u180B',
    '\u180F',
    '\uFE00',
    '\uFE0E',
    '\u{E0000}',
    '\u{E0041}',
    '\u{E0100}',
    '\u{1D173}',
  ];

  it.each(ignorable)(
    'codes reject the invisible %j (also after NFKC)',
    (ch) => {
      expect(hasFormatOrControlChars(normalizeIdentifierCode(`A${ch}B`))).toBe(
        true,
      );
    },
  );

  it('codes reject an interior line / paragraph separator or NEL (edges are trimmed)', () => {
    for (const ch of ['\u2028', '\u2029', '\u0085'])
      expect(hasFormatOrControlChars(normalizeIdentifierCode(`A${ch}B`))).toBe(
        true,
      );
    expect(normalizeIdentifierCode('\u2028\u0085A-1\u2029\u1680')).toBe('A-1');
  });

  it.each(ignorable)('names reject the invisible %j', (ch) => {
    expect(hasFormatChars(`Nama${ch}PT`)).toBe(true);
  });

  it('names keep emoji: ZWJ sequences, VS16 presentation, keycaps, flags, skin tones', () => {
    for (const ok of [
      'Keluarga 👨\u200D👩\u200D👧',
      'Toko ❤\uFE0F',
      '🏳\uFE0F\u200D🌈 Pride',
      '❤\uFE0F\u200D🔥',
      '🧔\u200D♂\uFE0F',
      '🧑🏽\u200D💻 Dev',
      'Nomor 1\uFE0F\u20E3',
      '🇮🇩 Indonesia',
    ])
      expect(hasFormatChars(ok)).toBe(false);
    // VS16 / ZWJ outside an emoji is still hidden text.
    expect(hasFormatChars('A\uFE0FB')).toBe(true);
    expect(hasFormatChars('❤\uFE0E')).toBe(true);
    expect(hasFormatChars('A\u200D😀')).toBe(true);
  });

  it('codes still reject every emoji joiner / selector', () => {
    expect(hasFormatOrControlChars('❤\uFE0F')).toBe(true);
  });
});

type Ctor = new () => object;
function validated(cls: Ctor, body: Record<string, unknown>) {
  const inst = plainToInstance(cls, body) as Record<string, unknown>;
  const failed = validateSync(inst, { skipMissingProperties: true }).map(
    (e) => e.property,
  );
  return { inst, failed };
}

describe('code/name DTO normalization (transform before validation)', () => {
  const codeDtos: [string, Ctor][] = [
    ['CreateAccountDto', CreateAccountDto],
    ['CreateTaxCodeDto', CreateTaxCodeDto],
    ['CreateBusinessPartnerDto', CreateBusinessPartnerDto],
  ];

  it.each(codeDtos)('%s normalizes code and name', (_n, cls) => {
    const { inst, failed } = validated(cls, {
      code: ' ＤＵＰ ',
      name: '  Nama  ',
    });
    expect(failed).not.toContain('code');
    expect(failed).not.toContain('name');
    expect(inst.code).toBe('DUP');
    expect(inst.name).toBe('Nama');
  });

  it.each(codeDtos)(
    '%s rejects a blank, white-space-only or zero-width code',
    (_n, cls) => {
      for (const code of ['', '   ', '　', 'DUP​', '‍', 'A\tB']) {
        expect(validated(cls, { code, name: 'Ok' }).failed).toContain('code');
      }
    },
  );

  const nameDtos: [string, Ctor][] = [
    ...codeDtos,
    ['UpdateAccountDto', UpdateAccountDto],
    ['UpdateTaxCodeDto', UpdateTaxCodeDto],
    ['UpdateBusinessPartnerDto', UpdateBusinessPartnerDto],
  ];

  it.each(nameDtos)(
    '%s rejects a blank or zero-width name and trims a valid one',
    (_n, cls) => {
      for (const name of ['', '  ', 'Na​ma', '﻿']) {
        expect(validated(cls, { code: 'OK', name }).failed).toContain('name');
      }
      expect(validated(cls, { code: 'OK', name: ' Nama ' }).inst.name).toBe(
        'Nama',
      );
    },
  );

  it('normalizes parentCode like a code', () => {
    const { inst, failed } = validated(CreateAccountDto, {
      parentCode: ' １-0000 ',
    });
    expect(failed).not.toContain('parentCode');
    expect(inst.parentCode).toBe('1-0000');
  });
});
