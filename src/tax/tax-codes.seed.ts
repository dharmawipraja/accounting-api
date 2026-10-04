import { TaxKind } from '@prisma/client';

interface SeedTaxCode {
  code: string;
  name: string;
  kind: TaxKind;
  rate: string;
  accountCode: string;
  /** Coretax presentation (PPN Output). */
  dppNilaiLain?: boolean;
  coretaxVatRate?: string;
}

export const TAX_CODE_SEED: SeedTaxCode[] = [
  {
    code: 'PPN-OUT-11',
    name: 'PPN Keluaran 11%',
    kind: 'PPN_OUTPUT',
    rate: '0.11',
    accountCode: '2-1100',
    // PMK 131/2024: 12% on DPP Nilai Lain 11/12 = 11% of DPP (non-luxury).
    dppNilaiLain: true,
    coretaxVatRate: '12',
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
    name: 'PPh 4(2) Sewa 10% (dipotong pelanggan, final)',
    kind: 'PPH_PREPAID',
    rate: '0.10',
    // Final tax — not creditable, so an expense rather than Uang Muka PPh.
    accountCode: '5-9100',
  },
];
