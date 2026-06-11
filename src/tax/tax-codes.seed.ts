import { TaxKind } from '@prisma/client';

export interface SeedTaxCode {
  code: string;
  name: string;
  kind: TaxKind;
  rate: string;
  accountCode: string;
}

export const TAX_CODE_SEED: SeedTaxCode[] = [
  {
    code: 'PPN-OUT-11',
    name: 'PPN Keluaran 11%',
    kind: 'PPN_OUTPUT',
    rate: '0.11',
    accountCode: '2-1100',
  },
  {
    code: 'PPN-IN-11',
    name: 'PPN Masukan 11%',
    kind: 'PPN_INPUT',
    rate: '0.11',
    accountCode: '1-1400',
  },
  {
    code: 'PPH23-PAY',
    name: 'PPh 23 Jasa 2% (dipotong)',
    kind: 'PPH_PAYABLE',
    rate: '0.02',
    accountCode: '2-1200',
  },
  {
    code: 'PPH23-PRE',
    name: 'PPh 23 Jasa 2% (dipungut)',
    kind: 'PPH_PREPAID',
    rate: '0.02',
    accountCode: '1-1500',
  },
  {
    code: 'PPH42-PAY',
    name: 'PPh 4(2) Sewa 10% (dipotong)',
    kind: 'PPH_PAYABLE',
    rate: '0.10',
    accountCode: '2-1200',
  },
  {
    code: 'PPH42-PRE',
    name: 'PPh 4(2) Sewa 10% (dipungut)',
    kind: 'PPH_PREPAID',
    rate: '0.10',
    accountCode: '1-1500',
  },
];
