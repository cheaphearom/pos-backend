// First start of a new server: create the super admin from ADMIN_EMAIL / ADMIN_PASSWORD
// when the database has no users yet. Safe to run on every start (does nothing afterwards).
// Demo data (prisma/seed.ts) is NOT loaded in production.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';

try {
  if ((await prisma.user.count()) > 0) {
    console.log('[bootstrap] users exist, nothing to do');
  } else if (!email || password.length < 10) {
    console.log('[bootstrap] no users yet: set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) to create the first admin');
  } else {
    await prisma.user.create({ data: { email, fullName: process.env.ADMIN_NAME || 'Administrator', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(password, 10) } });
    console.log(`[bootstrap] created super admin ${email}. Log in and change the password; you can remove ADMIN_PASSWORD from the .env now.`);
  }
} finally {
  await prisma.$disconnect();
}
