import { Prisma } from '@prisma/client';

/** One product's own option in one store (from product_options). */
export interface ProductOptionRow { optionId: string; groupId: string; price: Prisma.Decimal; isDefault: boolean }

type Db = { productOption: { findMany: (args: any) => Promise<any[]> } };

/**
 * The options each product offers in a store, by product. A group that has rows for a product is limited to those
 * options at those prices; a group without rows offers all its options at their normal price.
 */
export async function productOptionsFor(db: Db, storeId: string, productIds: string[]): Promise<Map<string, ProductOptionRow[]>> {
  const out = new Map<string, ProductOptionRow[]>();
  if (!productIds.length) return out;
  const rows = await db.productOption.findMany({
    where: { storeId, productId: { in: productIds } },
    select: { productId: true, optionId: true, priceDelta: true, isDefault: true, option: { select: { groupId: true } } },
  });
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push({ optionId: r.optionId, groupId: r.option.groupId, price: r.priceDelta, isDefault: r.isDefault });
    out.set(r.productId, list);
  }
  return out;
}
