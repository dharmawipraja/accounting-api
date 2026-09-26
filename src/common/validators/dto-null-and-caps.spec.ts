import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateUserDto } from '../../users/dto/update-user.dto';
import { UpdateCompanySettingsDto } from '../../company/dto/update-company-settings.dto';
import { UpdateAccountDto } from '../../ledger/accounts/dto/update-account.dto';
import { CreateAccountDto } from '../../ledger/accounts/dto/create-account.dto';
import { UpdateTaxCodeDto } from '../../tax/dto/update-tax-code.dto';
import { UpdateBusinessPartnerDto } from '../../invoicing/dto/update-business-partner.dto';
import { UpdateSalesInvoiceDto } from '../../invoicing/dto/update-sales-invoice.dto';
import { UpdatePurchaseBillDto } from '../../invoicing/dto/update-purchase-bill.dto';
import { CreateJournalEntryDto } from '../../ledger/journal/dto/create-journal-entry.dto';
import { JournalLineDto } from '../../ledger/journal/dto/journal-line.dto';
import { RefreshDto } from '../../auth/dto/refresh.dto';
import { LogoutDto } from '../../auth/dto/logout.dto';

type Ctor = new () => object;

/** Property names that failed validation (whitelist/forbid like the prod pipe). */
function failing(cls: Ctor, body: Record<string, unknown>): string[] {
  const errors = validateSync(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('update DTOs reject explicit null on NON-nullable fields (400, not Prisma)', () => {
  const cases: [string, Ctor, string[]][] = [
    ['UpdateUserDto', UpdateUserDto, ['name', 'role', 'isActive']],
    [
      'UpdateCompanySettingsDto',
      UpdateCompanySettingsDto,
      [
        'legalName',
        'fiscalYearStartMonth',
        'segregationOfDutiesEnabled',
        'isPkp',
      ],
    ],
    [
      'UpdateAccountDto',
      UpdateAccountDto,
      ['name', 'cashFlowCategory', 'isActive', 'role'],
    ],
    ['UpdateTaxCodeDto', UpdateTaxCodeDto, ['name', 'rate', 'isActive']],
    [
      'UpdateBusinessPartnerDto',
      UpdateBusinessPartnerDto,
      ['name', 'isCustomer', 'isVendor', 'isActive'],
    ],
    ['UpdateSalesInvoiceDto', UpdateSalesInvoiceDto, ['date', 'lines']],
    ['UpdatePurchaseBillDto', UpdatePurchaseBillDto, ['date', 'lines']],
  ];

  it.each(cases)('%s', (_name, cls, fields) => {
    for (const f of fields) {
      expect(failing(cls, { [f]: null })).toEqual([f]);
    }
    // absent keys stay optional
    expect(failing(cls, {})).toEqual([]);
  });

  it('keeps null as "clear" on nullable fields', () => {
    expect(
      failing(UpdateSalesInvoiceDto, { dueDate: null, description: null }),
    ).toEqual([]);
    expect(
      failing(UpdatePurchaseBillDto, {
        dueDate: null,
        vendorInvoiceNo: null,
        description: null,
      }),
    ).toEqual([]);
    expect(
      failing(UpdateBusinessPartnerDto, {
        npwp: null,
        email: null,
        phone: null,
        address: null,
      }),
    ).toEqual([]);
    expect(
      failing(UpdateCompanySettingsDto, { npwp: null, address: null }),
    ).toEqual([]);
  });
});

describe('@MaxLength caps on free-text inputs', () => {
  const s = (n: number) => 'x'.repeat(n);
  const cases: [string, Ctor, Record<string, unknown>, string, number][] = [
    ['company legalName', UpdateCompanySettingsDto, {}, 'legalName', 200],
    ['company npwp', UpdateCompanySettingsDto, {}, 'npwp', 32],
    ['company address', UpdateCompanySettingsDto, {}, 'address', 500],
    [
      'account parentCode',
      CreateAccountDto,
      {
        code: '9-9999',
        name: 'N',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
      },
      'parentCode',
      32,
    ],
    ['account rename', UpdateAccountDto, {}, 'name', 128],
    [
      'journal description',
      CreateJournalEntryDto,
      { date: '2026-01-15', lines: [] },
      'description',
      500,
    ],
    [
      'journal line description',
      JournalLineDto,
      { accountId: '8f14e45f-ceea-467a-9575-6a2c3a1c1e11' },
      'description',
      500,
    ],
    ['refresh token', RefreshDto, {}, 'refreshToken', 2048],
    ['logout token', LogoutDto, {}, 'refreshToken', 2048],
  ];

  it.each(cases)('%s', (_n, cls, base, field, max) => {
    const value = s(max);
    const over = s(max + 1);
    expect(failing(cls, { ...base, [field]: value })).not.toContain(field);
    expect(failing(cls, { ...base, [field]: over })).toContain(field);
  });
});
