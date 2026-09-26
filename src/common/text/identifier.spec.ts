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
