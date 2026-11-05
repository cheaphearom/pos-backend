/**
 * Demo data: 3 stores, staff for each role, 40 products, stock, customers.
 * Run: npm run db:seed   (safe to re-run; it upserts)
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const STORES = [
  { code: 'PP01', name: 'Phnom Penh - Central', address: 'Street 51, Daun Penh, Phnom Penh', phone: '023 000 001', taxRate: 0.1 },
  { code: 'PP02', name: 'Phnom Penh - Toul Kork', address: 'Street 315, Toul Kork, Phnom Penh', phone: '023 000 002', taxRate: 0.1 },
  { code: 'SR01', name: 'Siem Reap - Old Market', address: 'Pub Street, Siem Reap', phone: '063 000 001', taxRate: 0.1 },
];

const CATALOGUE: Record<string, [string, string, number, number, boolean?][]> = {
  // [name, unit, cost, price, taxable]
  Beverages: [
    ['Mineral Water 500ml', 'btl', 0.15, 0.35], ['Coca-Cola 330ml', 'can', 0.35, 0.65], ['Iced Coffee', 'cup', 0.6, 1.5],
    ['Green Tea 500ml', 'btl', 0.4, 0.8], ['Orange Juice 1L', 'btl', 1.2, 2.2], ['Energy Drink 250ml', 'can', 0.45, 0.9],
    ['Beer 330ml', 'can', 0.55, 1.0], ['Soy Milk 250ml', 'box', 0.3, 0.6],
  ],
  Snacks: [
    ['Potato Chips 70g', 'pack', 0.6, 1.1], ['Chocolate Bar', 'pcs', 0.5, 1.0], ['Instant Noodles', 'pack', 0.25, 0.5],
    ['Biscuits 200g', 'pack', 0.7, 1.3], ['Peanuts 150g', 'pack', 0.6, 1.2], ['Dried Mango 100g', 'pack', 1.1, 2.0],
  ],
  'Fresh Food': [
    ['Bananas', 'kg', 0.6, 1.2, false], ['Apples', 'kg', 1.8, 3.2, false], ['Jasmine Rice 5kg', 'bag', 4.5, 6.5, false],
    ['Eggs (10)', 'tray', 1.0, 1.6, false], ['Chicken Breast', 'kg', 3.0, 4.8, false], ['Bread Loaf', 'pcs', 0.9, 1.5, false],
  ],
  Household: [
    ['Laundry Detergent 1kg', 'pack', 2.0, 3.5], ['Dish Soap 500ml', 'btl', 0.8, 1.5], ['Toilet Paper (10)', 'pack', 2.5, 4.0],
    ['Trash Bags (30)', 'pack', 0.9, 1.8], ['Light Bulb LED 9W', 'pcs', 1.2, 2.5], ['Batteries AA (4)', 'pack', 1.0, 2.2],
  ],
  'Personal Care': [
    ['Shampoo 400ml', 'btl', 2.2, 3.9], ['Toothpaste 150g', 'pcs', 0.9, 1.7], ['Soap Bar', 'pcs', 0.35, 0.8],
    ['Hand Sanitizer 250ml', 'btl', 1.0, 2.0], ['Sunscreen SPF50', 'btl', 4.0, 7.5], ['Deodorant', 'pcs', 1.8, 3.2],
  ],
};

async function main() {
  const password = await bcrypt.hash('Password@123', 10);

  const stores = [];
  for (const s of STORES) {
    stores.push(await prisma.store.upsert({ where: { code: s.code }, update: s, create: s }));
  }

  const user = (email: string, fullName: string, role: Role, storeIds: string[]) =>
    prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, fullName, role, passwordHash: password, stores: { create: storeIds.map((storeId) => ({ storeId })) } },
    });

  await user('admin@pos.local', 'Super Admin', Role.SUPER_ADMIN, []);
  await user('manager.pp@pos.local', 'Sokha Chan (PP Manager)', Role.STORE_MANAGER, [stores[0].id, stores[1].id]);
  await user('manager.sr@pos.local', 'Dara Lim (SR Manager)', Role.STORE_MANAGER, [stores[2].id]);
  await user('cashier1@pos.local', 'Srey Mom (Cashier PP01)', Role.CASHIER, [stores[0].id]);
  await user('cashier2@pos.local', 'Visal Kim (Cashier PP02)', Role.CASHIER, [stores[1].id]);
  await user('cashier3@pos.local', 'Bopha Sok (Cashier SR01)', Role.CASHIER, [stores[2].id]);

  let n = 0;
  for (const [categoryName, items] of Object.entries(CATALOGUE)) {
    const category =
      (await prisma.category.findFirst({ where: { name: categoryName, parentId: null } })) ??
      (await prisma.category.create({ data: { name: categoryName } }));
    for (const [name, unit, cost, price, taxable = true] of items) {
      n++;
      const sku = `SKU-${String(n).padStart(4, '0')}`;
      const product = await prisma.product.upsert({
        where: { sku },
        update: {},
        create: {
          sku, name, unit, taxable,
          barcode: `885000${String(n).padStart(6, '0')}`,
          costPrice: cost, sellPrice: price, categoryId: category.id,
        },
      });
      for (const [i, store] of stores.entries()) {
        const quantity = 20 + ((n * 7 + i * 13) % 80);
        const existing = await prisma.inventory.findUnique({ where: { storeId_productId: { storeId: store.id, productId: product.id } } });
        if (existing) continue;
        await prisma.inventory.create({
          data: {
            storeId: store.id, productId: product.id, quantity, reorderLevel: 15,
            // Siem Reap is a tourist area: slightly higher prices
            priceOverride: store.code === 'SR01' ? Math.round(price * 1.1 * 100) / 100 : null,
          },
        });
        await prisma.stockMovement.create({
          data: { storeId: store.id, productId: product.id, type: 'PURCHASE', quantity, balanceAfter: quantity, note: 'Opening stock' },
        });
      }
    }
  }

  const customers = [
    ['M0000001', 'Chea Sokunthea', '012345678'], ['M0000002', 'Ly Vannak', '017222333'],
    ['M0000003', 'Heng Malis', '098765432'], ['M0000004', 'Tep Rithy', '010111222'],
  ];
  for (const [code, name, phone] of customers) {
    await prisma.customer.upsert({ where: { code }, update: {}, create: { code, name, phone, points: 500 } });
  }

  console.log(`Seeded ${stores.length} stores, ${n} products, ${customers.length} customers.`);
  console.log('Login: admin@pos.local / Password@123 (also manager.pp@, manager.sr@, cashier1@, cashier2@, cashier3@)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
