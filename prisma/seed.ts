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

  // Suppliers
  const suppliers = [
    { code: 'SUP-BEV', name: 'Mekong Beverages Co.', contactName: 'Mr. Sopheak', phone: '012 111 222', email: 'orders@mekongbev.example', paymentTermsDays: 30 },
    { code: 'SUP-FMCG', name: 'Angkor Distribution', contactName: 'Ms. Lina', phone: '015 333 444', paymentTermsDays: 15 },
    { code: 'SUP-FRESH', name: 'Kandal Fresh Farm', phone: '017 555 666', paymentTermsDays: 0 },
  ];
  for (const sup of suppliers) await prisma.supplier.upsert({ where: { code: sup.code }, update: {}, create: sup });

  // Promotions (demo)
  if (!(await prisma.promotion.count())) {
    const bev = await prisma.category.findFirst({ where: { name: 'Beverages' } });
    const noodles = await prisma.product.findFirst({ where: { name: 'Instant Noodles' } });
    await prisma.promotion.createMany({
      data: [
        { name: 'Drinks 10% off', type: 'PERCENT_OFF', value: 10, categoryIds: bev ? [bev.id] : [], description: 'All beverages' },
        { name: 'Noodles buy 2 get 1', type: 'BUY_X_GET_Y', buyQty: 2, getQty: 1, productIds: noodles ? [noodles.id] : [] },
        { name: 'Happy hour 20% (17:00-19:00)', type: 'PERCENT_OFF', value: 20, allProducts: true, startMinute: 17 * 60, endMinute: 19 * 60, isActive: false },
      ],
    });
  }

  // KHQR demo account on the first store (replace with your real Bakong account)
  await prisma.store.update({ where: { code: 'PP01' }, data: { khqrAccountId: 'demo_shop@aclb', khqrMerchantName: 'POS DEMO SHOP', khqrCity: 'Phnom Penh' } });

  // Wallet cards (demo): 10 unused cards + one active card with $20 for the first customer (PIN 1234)
  if (!(await prisma.walletCard.count())) {
    const luhn = (body: string) => {
      let sum = 0;
      for (let i = 0; i < body.length; i++) {
        let d = Number(body[body.length - 1 - i]);
        if (i % 2 === 0) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
      }
      return String((10 - (sum % 10)) % 10);
    };
    const cards = Array.from({ length: 11 }, (_, i) => {
      const body = `889900000000${String(i + 1).padStart(3, '0')}`;
      return { cardNumber: body + luhn(body), serialNumber: `DEMO${String(i + 1).padStart(2, '0')}-SERIAL` };
    });
    await prisma.walletCard.createMany({ data: cards });
    const member = await prisma.customer.findUnique({ where: { code: 'M0000001' } });
    const first = await prisma.walletCard.update({
      where: { cardNumber: cards[0].cardNumber },
      data: { status: 'ACTIVE', customerId: member?.id, balance: 20, activatedAt: new Date(), pinHash: await bcrypt.hash('1234', 10) },
    });
    await prisma.walletTransaction.create({ data: { cardId: first.id, type: 'TOPUP', amount: 20, balanceAfter: 20, method: 'CASH', note: 'Demo top-up' } });
    console.log(`Wallet demo card: ${cards[0].cardNumber} (PIN 1234, $20). Unused: ${cards[1].cardNumber} with serial ${cards[1].serialNumber}, ...`);
  }

  // Coupons and gift vouchers (demo)
  if (!(await prisma.couponCampaign.count())) {
    const welcome = await prisma.couponCampaign.create({
      data: { name: 'Welcome 10%', type: 'PERCENT', value: 10, minSpend: 5, maxDiscount: 3, perCustomerLimit: 1, membersOnly: true },
    });
    await prisma.couponCode.create({ data: { campaignId: welcome.id, code: 'WELCOME10', maxUses: null } });
    const lucky = await prisma.couponCampaign.create({ data: { name: 'Lucky $1 off', type: 'AMOUNT', value: 1, minSpend: 3 } });
    await prisma.couponCode.createMany({ data: ['LUCKY-AAAA1111', 'LUCKY-BBBB2222', 'LUCKY-CCCC3333'].map((code) => ({ campaignId: lucky.id, code, maxUses: 1 })) });

    const gift = await prisma.voucherBatch.create({ data: { name: '$10 gift voucher', value: 10, count: 3, sold: true } });
    await prisma.voucher.createMany({ data: ['GVDEMO10A', 'GVDEMO10B', 'GVDEMO10C'].map((code) => ({ batchId: gift.id, code, value: 10, balance: 10, status: 'INACTIVE' })) });
    const free = await prisma.voucherBatch.create({ data: { name: '$2 thank-you voucher', value: 2, count: 2, sold: false } });
    await prisma.voucher.createMany({ data: ['GVFREE2A', 'GVFREE2B'].map((code) => ({ batchId: free.id, code, value: 2, balance: 2, status: 'ACTIVE' })) });
    console.log('Coupons: WELCOME10 (members, 10%, min $5), LUCKY-AAAA1111 ($1 off). Vouchers: GVDEMO10A (sell first), GVFREE2A (free $2).');
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
