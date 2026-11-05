/**
 * Ingredients used by one unit of a product, after its options are applied.
 * Order: base recipe → SCALE (size, sugar level) → REPLACE (oat milk) → ADD (extra shot).
 */
export interface RecipeLine { ingredientId: string; quantity: number }
export interface RecipeEffect {
  type: 'SCALE' | 'REPLACE' | 'ADD';
  ingredientId?: string | null;
  replaceWithId?: string | null;
  quantity?: number | null;
  percent?: number | null;
}

/** Units counted in pieces (cups, lids, straws) are not changed by a "scale everything" effect. */
const PIECE_UNITS = new Set(['pcs', 'pc', 'piece', 'pieces', 'ea', 'each', 'unit']);
export const isPieceUnit = (unit: string | undefined) => PIECE_UNITS.has((unit ?? '').trim().toLowerCase());

export function ingredientUsage(recipe: RecipeLine[], effects: RecipeEffect[], unitOf: (id: string) => string | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of recipe) m.set(r.ingredientId, (m.get(r.ingredientId) ?? 0) + Number(r.quantity));

  for (const e of effects.filter((x) => x.type === 'SCALE')) {
    const f = 1 + Number(e.percent ?? 0) / 100;
    for (const [id, q] of m) {
      if (e.ingredientId ? id === e.ingredientId : !isPieceUnit(unitOf(id))) m.set(id, q * f);
    }
  }
  for (const e of effects.filter((x) => x.type === 'REPLACE')) {
    if (!e.ingredientId || !e.replaceWithId || !m.has(e.ingredientId)) continue;
    const q = m.get(e.ingredientId)!;
    m.delete(e.ingredientId);
    m.set(e.replaceWithId, (m.get(e.replaceWithId) ?? 0) + q);
  }
  for (const e of effects.filter((x) => x.type === 'ADD')) {
    if (e.ingredientId) m.set(e.ingredientId, (m.get(e.ingredientId) ?? 0) + Number(e.quantity ?? 0));
  }
  for (const [id, q] of m) {
    const r = Math.round(Math.max(0, q) * 10000) / 10000;
    if (r > 0) m.set(id, r);
    else m.delete(id);
  }
  return m;
}

/** Cost of the usage at the given cost per unit. */
export const usageCost = (usage: Map<string, number>, costOf: (id: string) => number) =>
  [...usage].reduce((s, [id, q]) => s + q * costOf(id), 0);
