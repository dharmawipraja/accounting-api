/**
 * Database Seed Script
 *
 * Creates initial admin user for the accounting system
 */

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { hashPassword } from '../src/middleware/auth.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  try {
    // Check if admin user already exists
    const existingAdmin = await prisma.user.findFirst({
      where: { role: 'ADMIN' }
    });

    if (existingAdmin) {
      console.log('⚠️  Admin user already exists:', existingAdmin.username);
      return;
    }

    // Create default admin user
    const adminPassword = 'admin123456';
    const hashedPassword = await hashPassword(adminPassword);

    const adminUser = await prisma.user.create({
      data: {
        id: ulid(),
        username: 'admin',
        password: hashedPassword,
        name: 'System Administrator',
        role: 'ADMIN',
        status: 'ACTIVE',
        updatedAt: new Date()
      }
    });

    console.log('✅ Admin user created successfully:');
    console.log(`   Username: ${adminUser.username}`);
    console.log(`   Password: ${adminPassword} (change this in production!)`);
    console.log(`   Role: ${adminUser.role}`);
    console.log(`   ID: ${adminUser.id}`);

    // Create a sample manager user
    const managerPassword = 'manager123456';
    const hashedManagerPassword = await hashPassword(managerPassword);

    const managerUser = await prisma.user.create({
      data: {
        id: ulid(),
        username: 'manager',
        password: hashedManagerPassword,
        name: 'Sample Manager',
        role: 'MANAJER',
        status: 'ACTIVE',
        updatedAt: new Date()
      }
    });

    console.log('✅ Manager user created successfully:');
    console.log(`   Username: ${managerUser.username}`);
    console.log(`   Password: ${managerPassword} (change this in production!)`);
    console.log(`   Role: ${managerUser.role}`);
    console.log(`   ID: ${managerUser.id}`);

    // Create a sample regular user
    const userPassword = 'user123456';
    const hashedUserPassword = await hashPassword(userPassword);

    const regularUser = await prisma.user.create({
      data: {
        id: ulid(),
        username: 'nasabah1',
        password: hashedUserPassword,
        name: 'Sample Nasabah',
        role: 'NASABAH',
        status: 'ACTIVE',
        updatedAt: new Date()
      }
    });

    console.log('✅ Regular user created successfully:');
    console.log(`   Username: ${regularUser.username}`);
    console.log(`   Password: ${userPassword} (change this in production!)`);
    console.log(`   Role: ${regularUser.role}`);
    console.log(`   ID: ${regularUser.id}`);

    console.log('\n🎉 Database seeding completed successfully!');
    console.log('\n🔐 You can now login with:');
    console.log('   Admin: admin / admin123456');
    console.log('   Manager: manager / manager123456');
    console.log('   Nasabah: nasabah1 / user123456');
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
