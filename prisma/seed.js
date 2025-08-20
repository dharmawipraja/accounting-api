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
      // ASSET ACCOUNTS
      {
        accountNumber: '1000',
        accountName: 'ASET LANCAR',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1100',
        accountName: 'KAS DAN SETARA KAS',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1200',
        accountName: 'PIUTANG',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1300',
        accountName: 'PERSEDIAAN',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1400',
        accountName: 'ASET TETAP',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },

      // LIABILITY ACCOUNTS
      {
        accountNumber: '2000',
        accountName: 'HUTANG LANCAR',
        accountCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '2100',
        accountName: 'HUTANG USAHA',
        accountCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '2200',
        accountName: 'HUTANG JANGKA PANJANG',
        accountCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },

      // EQUITY ACCOUNTS
      {
        accountNumber: '3000',
        accountName: 'MODAL',
        accountCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '3100',
        accountName: 'MODAL SAHAM',
        accountCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '3200',
        accountName: 'LABA DITAHAN',
        accountCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },

      // REVENUE ACCOUNTS
      {
        accountNumber: '4000',
        accountName: 'PENDAPATAN',
        accountCategory: 'PENDAPATAN',
        reportType: 'LABA_RUGI',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '4100',
        accountName: 'PENDAPATAN OPERASIONAL',
        accountCategory: 'PENDAPATAN',
        reportType: 'LABA_RUGI',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '4200',
        accountName: 'PENDAPATAN NON-OPERASIONAL',
        accountCategory: 'PENDAPATAN',
        reportType: 'LABA_RUGI',
        transactionType: 'CREDIT'
      },

      // EXPENSE ACCOUNTS
      {
        accountNumber: '5000',
        accountName: 'BIAYA OPERASIONAL',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5100',
        accountName: 'BIAYA PENJUALAN',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5200',
        accountName: 'BIAYA ADMINISTRASI',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      }
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
      // KAS DAN SETARA KAS DETAILS
      {
        accountNumber: '1101',
        accountName: 'Kas Besar',
        parentAccountNumber: '1100',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1102',
        accountName: 'Kas Kecil',
        parentAccountNumber: '1100',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1103',
        accountName: 'Bank BCA',
        parentAccountNumber: '1100',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1104',
        accountName: 'Bank Mandiri',
        parentAccountNumber: '1100',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1105',
        accountName: 'Bank BRI',
        parentAccountNumber: '1100',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },

      // PIUTANG DETAILS
      {
        accountNumber: '1201',
        accountName: 'Piutang Usaha',
        parentAccountNumber: '1200',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1202',
        accountName: 'Piutang Karyawan',
        parentAccountNumber: '1200',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1203',
        accountName: 'Piutang Lain-lain',
        parentAccountNumber: '1200',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },

      // PERSEDIAAN DETAILS
      {
        accountNumber: '1301',
        accountName: 'Persediaan Barang Dagang',
        parentAccountNumber: '1300',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1302',
        accountName: 'Persediaan Bahan Baku',
        parentAccountNumber: '1300',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },

      // ASET TETAP DETAILS
      {
        accountNumber: '1401',
        accountName: 'Tanah',
        parentAccountNumber: '1400',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1402',
        accountName: 'Bangunan',
        parentAccountNumber: '1400',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1403',
        accountName: 'Kendaraan',
        parentAccountNumber: '1400',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '1404',
        accountName: 'Peralatan Kantor',
        parentAccountNumber: '1400',
        accountCategory: 'ASSET',
        reportType: 'NERACA',
        transactionType: 'DEBIT'
      },

      // HUTANG USAHA DETAILS
      {
        accountNumber: '2101',
        accountName: 'Hutang Supplier',
        parentAccountNumber: '2100',
        accountCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '2102',
        accountName: 'Hutang Pajak',
        parentAccountNumber: '2100',
        accountCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '2103',
        accountName: 'Hutang Gaji',
        parentAccountNumber: '2100',
        accountCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },

      // HUTANG JANGKA PANJANG DETAILS
      {
        accountNumber: '2201',
        accountName: 'Hutang Bank',
        parentAccountNumber: '2200',
        accountCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '2202',
        accountName: 'Hutang Obligasi',
        parentAccountNumber: '2200',
        accountCategory: 'HUTANG',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },

      // MODAL SAHAM DETAILS
      {
        accountNumber: '3101',
        accountName: 'Modal Saham Biasa',
        parentAccountNumber: '3100',
        accountCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '3102',
        accountName: 'Modal Saham Preferen',
        parentAccountNumber: '3100',
        accountCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },

      // LABA DITAHAN DETAILS
      {
        accountNumber: '3201',
        accountName: 'Laba Ditahan Tahun Berjalan',
        parentAccountNumber: '3200',
        accountCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '3202',
        accountName: 'Laba Ditahan Tahun Lalu',
        parentAccountNumber: '3200',
        accountCategory: 'MODAL',
        reportType: 'NERACA',
        transactionType: 'CREDIT'
      },

      // PENDAPATAN OPERASIONAL DETAILS
      {
        accountNumber: '4101',
        accountName: 'Penjualan Barang',
        parentAccountNumber: '4100',
        accountCategory: 'PENDAPATAN',
        reportType: 'LABA_RUGI',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '4102',
        accountName: 'Pendapatan Jasa',
        parentAccountNumber: '4100',
        accountCategory: 'PENDAPATAN',
        reportType: 'LABA_RUGI',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '4103',
        accountName: 'Diskon Pembelian',
        parentAccountNumber: '4100',
        accountCategory: 'PENDAPATAN',
        reportType: 'LABA_RUGI',
        transactionType: 'CREDIT'
      },

      // PENDAPATAN NON-OPERASIONAL DETAILS
      {
        accountNumber: '4201',
        accountName: 'Pendapatan Bunga',
        parentAccountNumber: '4200',
        accountCategory: 'PENDAPATAN',
        reportType: 'LABA_RUGI',
        transactionType: 'CREDIT'
      },
      {
        accountNumber: '4202',
        accountName: 'Pendapatan Lain-lain',
        parentAccountNumber: '4200',
        accountCategory: 'PENDAPATAN',
        reportType: 'LABA_RUGI',
        transactionType: 'CREDIT'
      },

      // BIAYA PENJUALAN DETAILS
      {
        accountNumber: '5101',
        accountName: 'Gaji Sales',
        parentAccountNumber: '5100',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5102',
        accountName: 'Komisi Penjualan',
        parentAccountNumber: '5100',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5103',
        accountName: 'Biaya Promosi',
        parentAccountNumber: '5100',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5104',
        accountName: 'Biaya Pengiriman',
        parentAccountNumber: '5100',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },

      // BIAYA ADMINISTRASI DETAILS
      {
        accountNumber: '5201',
        accountName: 'Gaji Karyawan',
        parentAccountNumber: '5200',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5202',
        accountName: 'Biaya Listrik',
        parentAccountNumber: '5200',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5203',
        accountName: 'Biaya Telepon',
        parentAccountNumber: '5200',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5204',
        accountName: 'Biaya Sewa Kantor',
        parentAccountNumber: '5200',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5205',
        accountName: 'Biaya Penyusutan',
        parentAccountNumber: '5200',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5206',
        accountName: 'Biaya Supplies',
        parentAccountNumber: '5200',
        accountCategory: 'BIAYA',
        reportType: 'LABA_RUGI',
        transactionType: 'DEBIT'
      },
      {
        accountNumber: '5207',
        accountName: 'Biaya Maintenance',
        parentAccountNumber: '5200',
        accountCategory: 'BIAYA',
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
