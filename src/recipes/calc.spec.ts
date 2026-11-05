import { ingredientUsage, usageCost } from './calc';

const units: Record<string, string> = { beans: 'g', milk: 'ml', oat: 'ml', syrup: 'ml', cup12: 'pcs', cup16: 'pcs', lid: 'pcs', cream: 'g' };
const unitOf = (id: string) => units[id];
const latte = [
  { ingredientId: 'beans', quantity: 18 }, { ingredientId: 'milk', quantity: 200 }, { ingredientId: 'syrup', quantity: 20 },
  { ingredientId: 'cup12', quantity: 1 }, { ingredientId: 'lid', quantity: 1 },
];
const asObj = (m: Map<string, number>) => Object.fromEntries([...m].sort());

describe('recipe usage', () => {
  it('base recipe', () => {
    expect(asObj(ingredientUsage(latte, [], unitOf))).toEqual({ beans: 18, cup12: 1, lid: 1, milk: 200, syrup: 20 });
  });
  it('Large: +30% except pieces, bigger cup; oat milk; 50% sugar; extra shot; whipped cream', () => {
    const u = ingredientUsage(latte, [
      { type: 'SCALE', percent: 30 }, // Large
      { type: 'REPLACE', ingredientId: 'cup12', replaceWithId: 'cup16' }, // Large
      { type: 'SCALE', ingredientId: 'syrup', percent: -50 }, // 50% sugar
      { type: 'REPLACE', ingredientId: 'milk', replaceWithId: 'oat' }, // oat milk
      { type: 'ADD', ingredientId: 'beans', quantity: 9 }, // extra shot
      { type: 'ADD', ingredientId: 'cream', quantity: 15 }, // whipped cream (not in recipe)
    ], unitOf);
    expect(asObj(u)).toEqual({ beans: 32.4, cream: 15, cup16: 1, lid: 1, oat: 260, syrup: 13 });
  });
  it('replace only when the drink has that ingredient; 0% sugar removes it', () => {
    const americano = [{ ingredientId: 'beans', quantity: 18 }, { ingredientId: 'syrup', quantity: 20 }];
    const u = ingredientUsage(americano, [{ type: 'REPLACE', ingredientId: 'milk', replaceWithId: 'oat' }, { type: 'SCALE', ingredientId: 'syrup', percent: -100 }], unitOf);
    expect(asObj(u)).toEqual({ beans: 18 });
  });
  it('cost', () => {
    const u = ingredientUsage(latte, [], unitOf);
    const cost: Record<string, number> = { beans: 0.015, milk: 0.0016, syrup: 0.002, cup12: 0.05, lid: 0.02 };
    expect(usageCost(u, (id) => cost[id])).toBeCloseTo(18 * 0.015 + 200 * 0.0016 + 20 * 0.002 + 0.05 + 0.02, 6);
  });
});
