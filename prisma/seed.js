/**
 * Database Seed Script
 *
 * Creates initial admin user for the accounting system
 */

/* eslint-disable no-console */

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { hashPassword } from '../src/core/middleware/auth.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  try {
    // Check if data already exists
    const existingUser = await prisma.user.findFirst();
    const existingAccountGeneral = await prisma.accountGeneral.findFirst();

    if (existingUser && existingAccountGeneral) {
      console.log('⚠️  Database already seeded. Skipping...');
      return;
    }

    // ========================
    // SEED USERS
    // ========================
    console.log('\n👥 Creating users...');

    const users = [
      {
        username: 'admin',
        password: 'admin123456',
        name: 'System Administrator',
        role: 'ADMIN'
      },
      {
        username: 'akuntan',
        password: 'akuntan123456',
        name: 'Kepala Akuntan',
        role: 'AKUNTAN'
      },
      {
        username: 'manager',
        password: 'manager123456',
        name: 'Manajer Keuangan',
        role: 'MANAJER'
      },
      {
        username: 'kasir1',
        password: 'kasir123456',
        name: 'Kasir Utama',
        role: 'KASIR'
      },
      {
        username: 'kasir2',
        password: 'kasir123456',
        name: 'Kasir Cabang',
        role: 'KASIR'
      },
      {
        username: 'kolektor1',
        password: 'kolektor123456',
        name: 'Kolektor Area 1',
        role: 'KOLEKTOR'
      },
      {
        username: 'nasabah1',
        password: 'nasabah123456',
        name: 'Ahmad Nasabah',
        role: 'NASABAH'
      },
      {
        username: 'nasabah2',
        password: 'nasabah123456',
        name: 'Siti Nasabah',
        role: 'NASABAH'
      }
    ];

    const createdUsers = [];

    // Create admin user first to use as createdBy for other users
    const adminUserData = users.find(u => u.role === 'ADMIN');
    const hashedAdminPassword = await hashPassword(adminUserData.password);
    const adminUser = await prisma.user.create({
      data: {
        id: ulid(),
        username: adminUserData.username,
        password: hashedAdminPassword,
        name: adminUserData.name,
        role: adminUserData.role,
        status: 'ACTIVE',
        createdBy: 'SYSTEM', // System creates the first admin
        forceLogout: false,
        updatedAt: new Date()
      }
    });
    createdUsers.push(adminUser);
    console.log(`   ✅ Created user: ${adminUserData.username} (${adminUserData.role})`);

    // Create other users with admin as createdBy
    for (const userData of users) {
      if (userData.role === 'ADMIN') continue; // Already created

      const hashedPassword = await hashPassword(userData.password);
      const user = await prisma.user.create({
        data: {
          id: ulid(),
          username: userData.username,
          password: hashedPassword,
          name: userData.name,
          role: userData.role,
          status: 'ACTIVE',
          createdBy: adminUser.id,
          forceLogout: false,
          updatedAt: new Date()
        }
      });
      createdUsers.push(user);
      console.log(`   ✅ Created user: ${userData.username} (${userData.role})`);
    }

    // Get admin user reference for creating accounts
    const adminUserRef = createdUsers.find(u => u.role === 'ADMIN');

    // ========================
    // SEED ACCOUNT GENERAL
    // ========================
    console.log('\n🏛️  Creating general accounts...');

    const generalAccounts = [
      {
        accountNumber: '1001',
        accountName: 'KAS',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1002',
        accountName: 'BANK',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1003',
        accountName: 'Piutang Anggota',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1004',
        accountName: 'Piutang Non Anggota',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1005',
        accountName: 'Persediaan Barang BKP',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1006',
        accountName: 'Persediaan Barang NON BKP',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1007',
        accountName: 'Uang Muka Perdaganagan',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1008',
        accountName: 'PPn Masukan',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1009',
        accountName: 'Persediaan Suplies Kantor',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1010',
        accountName: 'Piutang Pinjaman',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LANCAR',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },

      {
        accountNumber: '1301',
        accountName: 'Kendaraan',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1302',
        accountName: 'Akumulasi Penyusutan', // Duplicated ?
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1303',
        accountName: 'Inventaris',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1304',
        accountName: 'Akumulasi Penyusutan', // Duplicated ?
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1305',
        accountName: 'Perlengkapan',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1306',
        accountName: 'Akumulasi Penyusutan', // Duplicated ?
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1307',
        accountName: 'Bangunan',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1308',
        accountName: 'Akumulasi Penyusutan', // Duplicated ?
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1309',
        accountName: 'Mesin',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1310',
        accountName: 'Akumulasi Penyusutan', // Duplicated ?
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_TETAP',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },

      {
        accountNumber: '1401',
        accountName: 'Piutang Ragu-ragu unit Perdagangan',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LAINNYA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1402',
        accountName: 'Cadangan Penghapusan Piutang',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LAINNYA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1403',
        accountName: 'Sewa Gedung',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LAINNYA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1404',
        accountName: 'Amortisasi Sewa',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LAINNYA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1405',
        accountName: 'Sewa diterima dimuka',
        accountCategory: 'AKTIVA',
        accountSubCategory: 'AKTIVA_LAINNYA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },

      {
        accountNumber: '2000',
        accountName: 'Hutang Anggota',
        accountCategory: 'PASIVA',
        accountSubCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '2001',
        accountName: 'Hutang NON Anggota',
        accountCategory: 'PASIVA',
        accountSubCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '2002',
        accountName: 'Hutang by yg masih hrs bayar',
        accountCategory: 'PASIVA',
        accountSubCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '2003',
        accountName: 'Hutang PPn',
        accountCategory: 'PASIVA',
        accountSubCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '2004',
        accountName: 'Sewa diterima dimuka',
        accountCategory: 'PASIVA',
        accountSubCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '2007',
        accountName: 'PPn Keluaran',
        accountCategory: 'PASIVA',
        accountSubCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '2008',
        accountName: 'Hutang Antar Unit',
        accountCategory: 'PASIVA',
        accountSubCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },

      {
        accountNumber: '301',
        accountName: 'Modal Kerja',
        accountCategory: 'PASIVA',
        accountSubCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '302',
        accountName: 'Modal Kerja Tambahan',
        accountCategory: 'PASIVA',
        accountSubCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '303',
        accountName: 'Cadangan Unit Perdagangan',
        accountCategory: 'PASIVA',
        accountSubCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '304',
        accountName: 'SHU Tahun Lalu',
        accountCategory: 'PASIVA',
        accountSubCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '305',
        accountName: 'SHU Tahun Berjalan',
        accountCategory: 'PASIVA',
        accountSubCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },

      {
        accountNumber: '4000',
        accountName: 'Penjualan Barang BKP',
        accountCategory: 'PENJUALAN',
        accountSubCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '4001',
        accountName: 'Penjualan Barang NON BKP',
        accountCategory: 'PENJUALAN',
        accountSubCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '4002',
        accountName: 'Pendapatan Lainnya',
        accountCategory: 'PENJUALAN',
        accountSubCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },

      {
        accountNumber: '5000',
        accountName: 'Harga Pokok Penjualan BKP',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'HARGA_POKOK_PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5001',
        accountName: 'Harga Pokok Penjualan NON BKP',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'HARGA_POKOK_PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5002',
        accountName: 'Harga Pokok Variabel',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'HARGA_POKOK_PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },

      {
        accountNumber: '5100',
        accountName: 'Biaya Gaji',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BEBAN_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5101',
        accountName: 'Biaya Pakaian Karyawan',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BEBAN_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5102',
        accountName: 'Biaya THR',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BEBAN_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5103',
        accountName: 'Biaya Penyusutan',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BEBAN_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5104',
        accountName: 'Biaya Amortisasi Sewa Gedung',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BEBAN_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5105',
        accountName: 'Biaya Cad. Penghapusan Piutang',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BEBAN_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },

      {
        accountNumber: '5201',
        accountName: 'Biaya ATK',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5202',
        accountName: 'Biaya Telpon & Listrik & Pdam',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5203',
        accountName: 'Biaya Service & Spare Part & BBM',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5204',
        accountName: 'Biaya Perjalanan Dinas',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5205',
        accountName: 'Biaya Konsumsi',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5206',
        accountName: 'Biaya BPJS & Jamsostek',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5207',
        accountName: 'Biaya Banten',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5208',
        accountName: 'Biaya Meterai',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5209',
        accountName: 'Biaya Fotocopy',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5210',
        accountName: 'Biaya Perlengkapan Kantor',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5211',
        accountName: 'Biaya RAT',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5250',
        accountName: 'Biaya Tidak Tetap lainnya',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'BIAYA_TIDAK_TETAP',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },

      {
        accountNumber: '5301',
        accountName: 'Pendapatan Jasa Bank / Lainnya',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'PENDAPATAN_DAN_BIAYA_LAINNYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5302',
        accountName: 'Biaya Administrasi Bank / Lainnya',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'PENDAPATAN_DAN_BIAYA_LAINNYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },

      {
        accountNumber: '54', // ?
        accountName: 'Taksiran Pajak',
        accountCategory: 'BEBAN_DAN_BIAYA',
        accountSubCategory: 'TAKSIRAN_PAJAK',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
    ];

    const createdGeneralAccounts = [];
    for (const account of generalAccounts) {
      const generalAccount = await prisma.accountGeneral.create({
        data: {
          id: ulid(),
          accountNumber: account.accountNumber,
          accountName: account.accountName,
          accountType: 'GENERAL',
          accountCategory: account.accountCategory,
          accountSubCategory: account.accountSubCategory,
          reportType: account.reportType,
          transactionType: account.transactionType,
          initialAmountCredit: 0,
          initialAmountDebit: 0,
          accumulationAmountCredit: 0,
          accumulationAmountDebit: 0,
          amountCredit: 0,
          amountDebit: 0,
          createdBy: adminUserRef.id,
          updatedBy: adminUserRef.id,
          updatedAt: new Date()
        }
      });
      createdGeneralAccounts.push(generalAccount);
      console.log(
        `   ✅ Created general account: ${account.accountNumber} - ${account.accountName}`
      );
    }

    // ========================
    // SEED ACCOUNT DETAIL
    // ========================
    console.log('\n📋 Creating detail accounts...');

    const detailAccounts = [
      {
        accountNumber: '1006',
        accountName: 'Kas',
        parentAccountNumber: '1001',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '101016',
        accountName: 'BNI Giro cabang negara',
        parentAccountNumber: '1002',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '101017',
        accountName: 'Taplus BNI',
        parentAccountNumber: '1002',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '101018',
        accountName: 'USP Puskud Bali Dwipa',
        parentAccountNumber: '1002',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '101019',
        accountName: 'Bukopin Aktif',
        parentAccountNumber: '1002',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '101020',
        accountName: 'Deposito',
        parentAccountNumber: '1002',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '102024',
        accountName: 'Piutang perwakilan negara',
        parentAccountNumber: '1003',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '102025',
        accountName: 'Piutang kurang lancar',
        parentAccountNumber: '1003',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '102026',
        accountName: 'Piutang Exs. Devo V Negara',
        parentAccountNumber: '1003',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '102027',
        accountName: 'Piutang Antar Unit',
        parentAccountNumber: '1003',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1056',
        accountName: 'Persediaan Barang BKP',
        parentAccountNumber: '1004',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1057',
        accountName: 'Persediaan Barang NON BKP',
        parentAccountNumber: '1005',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '133022',
        accountName: 'Invent. Kend. (perolehan)',
        parentAccountNumber: '1301',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '133023',
        accountName: 'Akum kendaraan',
        parentAccountNumber: '1302',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '134022',
        accountName: 'Inventaris (percabahan)',
        parentAccountNumber: '1303',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '134023',
        accountName: 'Akum Inventaris',
        parentAccountNumber: '1304',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '135020',
        accountName: 'Bangunan (perolehan)',
        parentAccountNumber: '1307',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '135021',
        accountName: 'Akum Bangunan',
        parentAccountNumber: '1308',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '136020',
        accountName: 'Tanah (perolehan)',
        parentAccountNumber: '1403',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '136021',
        accountName: 'Akum Tanah',
        parentAccountNumber: '1404',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140053',
        accountName: 'Uang Muka Pakaian',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140054',
        accountName: 'Uang Muka THR',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140055',
        accountName: 'Uang Muka Polar',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140056',
        accountName: 'Uang Muka Rapel Gaji',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140057',
        accountName: 'Uang Muka Samsat Mobil',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140058',
        accountName: 'Um Perjalanan Luar Daerah',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140059',
        accountName: 'Um Program komputer',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140060',
        accountName: 'Um Ongkos angkut polar',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140061',
        accountName: 'Uang Muka Odalan',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140062',
        accountName: 'Uang Muka Spare Part',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '140063',
        accountName: 'Uang Muka Administrasi Kredit',
        parentAccountNumber: '1007',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '141062',
        accountName: 'Piutang ragu-ragu unit',
        parentAccountNumber: '1401',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '141063',
        accountName: 'Cad. penyesuaian Piutang',
        parentAccountNumber: '1402',
        accountCategory: 'AKTIVA',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '200457',
        accountName: 'Hutang Odalan',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200458',
        accountName: 'Hutang RAT',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200459',
        accountName: 'Hutang PPH Polar',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200460',
        accountName: 'Hutang anggota',
        parentAccountNumber: '2000',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200461',
        accountName: 'Hutang Spare Part',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200462',
        accountName: 'Hutang Perjalanan Luar Daerah',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200463',
        accountName: 'Hutang Penyisihan Piutang',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200464',
        accountName: 'Hutang Biaya Samsat',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200465',
        accountName: 'Hutang Antar Unit',
        parentAccountNumber: '2008',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200466',
        accountName: 'Hutang Program Computer',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200467',
        accountName: 'Hutang Rapel Gaji',
        parentAccountNumber: '2008',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200468',
        accountName: 'Hutang non anggota',
        parentAccountNumber: '2001',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200469',
        accountName: 'Hutang USP Puskud Bali Dwipa',
        parentAccountNumber: '2008',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200470',
        accountName: 'Hutang PPn',
        parentAccountNumber: '2007',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200471',
        accountName: 'Hutang biaya pakaian',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200472',
        accountName: 'Hutang THR',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '200473',
        accountName: 'Hutang FEE BELI POLAR',
        parentAccountNumber: '2002',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '300318',
        accountName: 'Modal Kerja',
        parentAccountNumber: '301',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '34006',
        accountName: 'Shu tahun ini',
        parentAccountNumber: '305',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '3506',
        accountName: 'Laba-rugi tahun lalu',
        parentAccountNumber: '304',
        accountCategory: 'PASIVA',
        reportType: 'NERACA',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40450',
        accountName: 'Penjualan NON BKP',
        parentAccountNumber: '4001',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40451',
        accountName: 'Pendp. Angkut Prangko Gudang',
        parentAccountNumber: '4002',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40452',
        accountName: 'Return Penjualan BKP',
        parentAccountNumber: '4000',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40453',
        accountName: 'Return Penjualan NON BKP',
        parentAccountNumber: '4001',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40454',
        accountName: 'Discount Penjualan BKP',
        parentAccountNumber: '4000',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40455',
        accountName: 'Discount Penjualan NON BKP',
        parentAccountNumber: '4001',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40456',
        accountName: 'Pendapatan Jasa Tabungan',
        parentAccountNumber: '4002',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40457',
        accountName: 'Pendapatan Jasa Giro',
        parentAccountNumber: '4002',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40458',
        accountName: 'Pendapatan Jasa / PBSU',
        parentAccountNumber: '4002',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40460',
        accountName: 'Pendapatan Fee',
        parentAccountNumber: '4002',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40461',
        accountName: 'Pendapatan Pajak/Fee Steak Hol',
        parentAccountNumber: '4002',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '40470',
        accountName: 'Penjualan BKP',
        parentAccountNumber: '4000',
        accountCategory: 'PENJUALAN',
        reportType: 'LABA_RUGI',
        transactionType: 'KREDIT'
      },
      {
        accountNumber: '50632',
        accountName: 'Return Pemb. Non BKP',
        parentAccountNumber: '4001',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '50633',
        accountName: 'Biaya pokok variabel',
        parentAccountNumber: '5002',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '50641',
        accountName: 'Pembelian BKP',
        parentAccountNumber: '5000',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '50642',
        accountName: 'Adjustment Persediaan stok BKP',
        parentAccountNumber: '5000',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '50643',
        accountName: 'Pembelian NON BKP',
        parentAccountNumber: '5001',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '50644',
        accountName: 'Adjustment Persediaan NON BKP',
        parentAccountNumber: '5001',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '50645',
        accountName: 'Return Pemb. BKP',
        parentAccountNumber: '5000',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507040',
        accountName: 'Penyusutan Kendaraan',
        parentAccountNumber: '5103',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507041',
        accountName: 'Penyusutan Inventaris',
        parentAccountNumber: '5103',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507042',
        accountName: 'Penyusutan Bangunan',
        parentAccountNumber: '5103',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507043',
        accountName: 'Penyusutan INV. Perlengkapan',
        parentAccountNumber: '5103',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507044',
        accountName: 'Penyusutan INV. Peralatan',
        parentAccountNumber: '5103',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507045',
        accountName: 'Biaya ATK',
        parentAccountNumber: '5201',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507046',
        accountName: 'Biaya telepon',
        parentAccountNumber: '5202',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507047',
        accountName: 'Biaya listrik',
        parentAccountNumber: '5202',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507048',
        accountName: 'Biaya pam',
        parentAccountNumber: '5202',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507049',
        accountName: 'Biaya perlengkapan kantor',
        parentAccountNumber: '5210',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507050',
        accountName: 'Biaya service komp/inventaris',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507051',
        accountName: 'Biaya perjalanan dalam daerah',
        parentAccountNumber: '5204',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507052',
        accountName: 'Biaya promosi',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507053',
        accountName: 'Biaya bbm',
        parentAccountNumber: '5203',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507054',
        accountName: 'Biaya pelumas',
        parentAccountNumber: '5203',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507055',
        accountName: 'Biaya spare part',
        parentAccountNumber: '5203',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507056',
        accountName: 'Biaya banten',
        parentAccountNumber: '5207',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507057',
        accountName: 'Biaya ongkos naik turun',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507058',
        accountName: 'Biaya ongkos angkut',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507060',
        accountName: 'Biaya konsumsi',
        parentAccountNumber: '5205',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507061',
        accountName: 'Biaya samsat',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507062',
        accountName: 'Biaya pengiriman barang dagang',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507063',
        accountName: 'Biaya lain-lain',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507064',
        accountName: 'Biaya Perjalanan Luar Daerah',
        parentAccountNumber: '5204',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507065',
        accountName: 'Biaya Penyisihan Piutang',
        parentAccountNumber: '5105',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507066',
        accountName: 'Biaya Tenaga Honor',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507067',
        accountName: 'Biaya Rapat Akhir Tahun',
        parentAccountNumber: '5211',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507068',
        accountName: 'Biaya Bunga Bank',
        parentAccountNumber: '5302',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507069',
        accountName: 'Biaya BPJS Kesehatan',
        parentAccountNumber: '5206',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507070',
        accountName: 'Biaya BPJS Tenaga Kerja',
        parentAccountNumber: '5206',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507071',
        accountName: 'Pajak Jasa Angk&sewa Gudang',
        parentAccountNumber: '5250',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507072',
        accountName: 'Biaya adm bank',
        parentAccountNumber: '5302',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507073',
        accountName: 'Beban Gaji karyawan',
        parentAccountNumber: '5100',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507074',
        accountName: 'Biaya pakaian karyawan',
        parentAccountNumber: '5101',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '507075',
        accountName: 'Biaya THR',
        parentAccountNumber: '5102',
        accountCategory: 'BEBAN_DAN_BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      }
    ];

    for (const account of detailAccounts) {
      await prisma.accountDetail.create({
        data: {
          id: ulid(),
          accountNumber: account.accountNumber,
          accountName: account.accountName,
          accountType: 'DETAIL',
          accountCategory: account.accountCategory,
          reportType: account.reportType,
          transactionType: account.transactionType,
          accountGeneralAccountNumber: account.parentAccountNumber,
          initialAmountCredit: 0,
          initialAmountDebit: 0,
          accumulationAmountCredit: 0,
          accumulationAmountDebit: 0,
          amountCredit: 0,
          amountDebit: 0,
          createdBy: adminUserRef.id,
          updatedBy: adminUserRef.id,
          updatedAt: new Date()
        }
      });
      console.log(
        `   ✅ Created detail account: ${account.accountNumber} - ${account.accountName}`
      );
    }

    console.log('\n🎉 Database seeding completed successfully!');

    console.log('\n📊 Summary:');
    console.log(`   👥 Users created: ${createdUsers.length}`);
    console.log(`   🏛️  General accounts created: ${createdGeneralAccounts.length}`);
    console.log(`   📋 Detail accounts created: ${detailAccounts.length}`);

    console.log('\n🔐 You can now login with:');
    console.log('   Admin: admin / admin123456');
    console.log('   Akuntan: akuntan / akuntan123456');
    console.log('   Manager: manager / manager123456');
    console.log('   Kasir: kasir1 / kasir123456');
    console.log('   Kolektor: kolektor1 / kolektor123456');
    console.log('   Nasabah: nasabah1 / nasabah123456');
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    throw error;
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
