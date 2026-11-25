/**
 * Ma'lumotni o'zgartiradigan barcha amallar shu yerda.
 * Brauzer har bir amalni o'zi yaratgan UUID bilan yuboradi (tugma ikki marta bosilsa ham amal bir marta bajariladi).
 * Server amalni processed_ops jadvali orqali faqat BIR MARTA bajaradi — bu idempotentlik.
 * Har bir amal bitta tranzaksiyada: yoki to'liq yoziladi, yoki umuman yozilmaydi.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tx, type Client } from '../db.ts';
import type { AuthUser } from '../auth.ts';
import { assertAdmin } from '../auth.ts';
import {
  AppError, D, Decimal, audit, bad, fmt, parse, todayStr,
  zDate, zMoney, zOptText, zPositiveMoney, zText, zUuid,
} from '../util.ts';
import { isDueDate } from './recurring.ts';

type Ctx = { c: Client; user: AuthUser };
type Handler = (ctx: Ctx, payload: unknown, opId: string) => Promise<unknown>;

export interface OpResult { opId: string; status: 'ok' | 'error'; result?: unknown; error?: string }

/** Ombor qoldig'ini o'zgartiradi. delta — asosiy birlikda (dona / kg / metr), kasr bo'lishi mumkin. */
async function moveStock(c: Client, productId: string, delta: Decimal.Value, type: string, refId: string | null, note: string | null, userId: string, at: Date, movementId: string = randomUUID()) {
  const d = D(delta).toFixed(3);
  const r = await c.query('UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1 RETURNING stock', [productId, d]);
  if (!r.rowCount) throw bad('Mahsulot topilmadi');
  await c.query(
    'INSERT INTO inventory_movements(id, product_id, delta, type, ref_id, note, user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [movementId, productId, d, type, refId, note, userId, at],
  );
  return r.rows[0].stock as string;
}

/** Miqdor: musbat, ko'pi bilan 3 kasr xona (1,5 kg; 2,25 metr). */
const zQty = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(',', '.'))
  .refine((v) => /^\d{1,10}(\.\d{1,3})?$/.test(v) && D(v).gt(0), 'Miqdor noto‘g‘ri')
  .transform((v) => D(v).toFixed(3));

/** Dona (yoki kasrsiz birlik) uchun miqdor butun son bo'lishi kerak. */
const DECIMAL_UNITS = new Set(['kg', 'metr', 'litr', 'gramm', 'm', 'l']);
function assertWhole(qty: string, unitName: string, productName: string) {
  if (!DECIMAL_UNITS.has(unitName.toLowerCase()) && !D(qty).isInteger()) {
    throw bad(`"${productName}" ${unitName}da sotiladi — miqdor butun son bo‘lishi kerak`);
  }
}

// ---------------- SAVDO ----------------
const saleSchema = z.object({
  id: zUuid,
  createdAt: z.string().optional(),
  items: z.array(z.object({
    productId: zUuid,
    unit: z.enum(['base', 'alt']).default('base'), // asosiy birlikda yoki ikkinchi birlikda (masalan qopda)
    qty: zQty,
    unitPrice: zMoney,
  })).min(1, 'Savat bo‘sh'),
  payments: z.array(z.object({ method: z.enum(['cash', 'card', 'click', 'debt']), amount: zMoney })),
  customer: z.object({ id: zUuid.optional(), name: zText(200), phone: zOptText(50) }).optional().nullable(),
  note: zOptText(),
});

const saleCreate: Handler = async ({ c, user }, payload) => {
  const p = parse(saleSchema, payload);
  const exists = await c.query('SELECT id, number FROM sales WHERE id=$1', [p.id]);
  if (exists.rowCount) return { id: p.id, number: Number(exists.rows[0].number) };
  const at = new Date();

  const ids = [...new Set(p.items.map((i) => i.productId))];
  const prods = await c.query('SELECT id, name, price, cost_price, unit, alt_unit, alt_factor, alt_price FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
  const byId = new Map(prods.rows.map((r) => [r.id, r]));

  let subtotal = D(0), total = D(0), cost = D(0);
  const lines = p.items.map((it, idx) => {
    const pr = byId.get(it.productId);
    if (!pr) throw bad('Savatdagi mahsulot topilmadi');
    const alt = it.unit === 'alt';
    if (alt && !pr.alt_unit) throw bad(`"${pr.name}" ikkinchi birlikda sotilmaydi`);
    const unitName: string = alt ? pr.alt_unit : pr.unit;
    const factor = alt ? D(pr.alt_factor) : D(1); // 1 sotilgan birlik = factor × asosiy birlik
    assertWhole(it.qty, unitName, pr.name);
    const basePrice = alt ? pr.alt_price : pr.price; // sotilgan birlikdagi oddiy narx
    const baseQty = D(it.qty).times(factor); // ombordan chiqadigan miqdor (asosiy birlikda)
    subtotal = subtotal.plus(D(basePrice).times(it.qty));
    total = total.plus(D(it.unitPrice).times(it.qty));
    cost = cost.plus(D(pr.cost_price).times(baseQty)); // tannarx asosiy birlik uchun
    return { ...it, lineNo: idx + 1, name: pr.name, basePrice, costPrice: pr.cost_price, unitName, factor: factor.toFixed(3), baseQty };
  });
  // Pul summalari tiyingacha yaxlitlanadi (kasr miqdor × narx)
  subtotal = subtotal.toDecimalPlaces(2);
  total = total.toDecimalPlaces(2);
  cost = cost.toDecimalPlaces(2);

  const pay = new Map<string, Decimal>();
  for (const pm of p.payments) {
    if (D(pm.amount).lte(0)) continue;
    pay.set(pm.method, (pay.get(pm.method) ?? D(0)).plus(pm.amount));
  }
  const paid = [...pay.values()].reduce((a, b) => a.plus(b), D(0));
  if (!paid.eq(total)) throw bad(`To‘lovlar yig‘indisi (${fmt(paid)}) savdo summasiga (${fmt(total)}) teng emas`);

  let customerId: string | null = null;
  const debt = pay.get('debt');
  if (p.customer?.name) {
    customerId = await findOrCreateCustomer(c, p.customer);
  }
  if (debt && !customerId) throw bad('Nasiya uchun xaridor ismini kiriting');

  const s = await c.query(
    'INSERT INTO sales(id, user_id, customer_id, subtotal, total, cost_total, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING number',
    [p.id, user.id, customerId, fmt(subtotal), fmt(total), fmt(cost), p.note, at],
  );
  for (const l of lines) {
    await c.query(
      'INSERT INTO sale_items(sale_id, line_no, product_id, product_name, qty, base_price, unit_price, cost_price, unit_name, unit_factor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [p.id, l.lineNo, l.productId, l.name, l.qty, l.basePrice, l.unitPrice, l.costPrice, l.unitName, l.factor],
    );
    await moveStock(c, l.productId, l.baseQty.neg(), 'sale', p.id, null, user.id, at);
  }
  for (const [method, amount] of pay) {
    await c.query('INSERT INTO sale_payments(sale_id, method, amount) VALUES ($1,$2,$3)', [p.id, method, fmt(amount)]);
  }
  if (debt) {
    await c.query('INSERT INTO debts(sale_id, customer_id, amount, note, created_at) VALUES ($1,$2,$3,$4,$5)', [p.id, customerId, fmt(debt), p.note, at]);
  }
  const number = Number(s.rows[0].number);
  await audit(c, user.id, 'sale.create', 'sale', p.id, { number, total: fmt(total), payments: Object.fromEntries([...pay].map(([k, v]) => [k, fmt(v)])) });
  return { id: p.id, number };
};

async function findOrCreateCustomer(c: Client, cu: { id?: string; name: string; phone: string | null }) {
  if (cu.id) {
    const r = await c.query('SELECT id FROM customers WHERE id=$1', [cu.id]);
    if (r.rowCount) return cu.id;
  }
  const found = await c.query(
    'SELECT id FROM customers WHERE lower(name)=lower($1) AND coalesce(phone, \'\') = coalesce($2, \'\') LIMIT 1',
    [cu.name, cu.phone],
  );
  if (found.rowCount) return found.rows[0].id as string;
  const id = cu.id ?? randomUUID();
  await c.query('INSERT INTO customers(id, name, phone) VALUES ($1,$2,$3)', [id, cu.name, cu.phone]);
  return id;
}

// ---------------- QAYTARISH ----------------
const returnSchema = z.object({
  id: zUuid,
  saleId: zUuid,
  createdAt: z.string().optional(),
  reason: zText(500).min(1, 'Qaytarish sababini yozing'),
  refundMethod: z.enum(['cash', 'card', 'click']).default('cash'),
  // qty — savdo qatori qaysi birlikda sotilgan bo'lsa, o'sha birlikda (masalan 1 qop yoki 2,5 kg)
  items: z.array(z.object({ saleItemId: zUuid, qty: zQty })).min(1, 'Qaytariladigan mahsulot tanlanmagan'),
});

const returnCreate: Handler = async ({ c, user }, payload) => {
  const p = parse(returnSchema, payload);
  const exists = await c.query('SELECT id FROM returns WHERE id=$1', [p.id]);
  if (exists.rowCount) return { id: p.id };
  const at = new Date();

  const sale = await c.query('SELECT id, number, created_at FROM sales WHERE id=$1 FOR UPDATE', [p.saleId]);
  if (!sale.rowCount) throw bad('Savdo topilmadi');
  if (at < sale.rows[0].created_at) throw bad('Qaytarish vaqti savdo vaqtidan oldin bo‘la olmaydi');
  const items = await c.query(
    `SELECT si.*, coalesce((SELECT sum(ri.qty) FROM return_items ri WHERE ri.sale_item_id = si.id), 0) AS returned
       FROM sale_items si WHERE si.sale_id = $1`,
    [p.saleId],
  );
  const byId = new Map(items.rows.map((r) => [r.id, r]));

  let total = D(0), base = D(0), cost = D(0);
  const want = new Map<string, Decimal>();
  for (const it of p.items) want.set(it.saleItemId, (want.get(it.saleItemId) ?? D(0)).plus(it.qty));
  for (const [sid, qty] of want) {
    const si = byId.get(sid);
    if (!si) throw bad('Qaytarilayotgan mahsulot bu savdoga tegishli emas');
    assertWhole(qty.toFixed(3), si.unit_name, si.product_name);
    const left = D(si.qty).minus(si.returned);
    if (qty.gt(left)) throw bad(`"${si.product_name}" dan faqat ${left.toString()} ${si.unit_name} qaytarish mumkin`);
    total = total.plus(D(si.unit_price).times(qty));
    base = base.plus(D(si.base_price).times(qty));
    cost = cost.plus(D(si.cost_price).times(qty).times(si.unit_factor)); // tannarx asosiy birlik uchun
  }
  total = total.toDecimalPlaces(2);
  base = base.toDecimalPlaces(2);
  cost = cost.toDecimalPlaces(2);

  // Avval shu savdoning to'lanmagan nasiya qarzi kamaytiriladi, qolgani pul bilan qaytariladi.
  let debtReduction = D(0);
  const d = await c.query('SELECT id FROM debts WHERE sale_id=$1 FOR UPDATE', [p.saleId]);
  if (d.rowCount) {
    const outstanding = await debtRemaining(c, d.rows[0].id);
    debtReduction = Decimal.min(outstanding, total);
  }
  const refund = total.minus(debtReduction);
  const refunds = { cash: D(0), card: D(0), click: D(0) };
  refunds[p.refundMethod] = refund;

  await c.query(
    `INSERT INTO returns(id, sale_id, user_id, reason, total, base_total, cost_total, refund_cash, refund_card, refund_click, debt_reduction, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [p.id, p.saleId, user.id, p.reason, fmt(total), fmt(base), fmt(cost), fmt(refunds.cash), fmt(refunds.card), fmt(refunds.click), fmt(debtReduction), at],
  );
  for (const [sid, qty] of want) {
    const si = byId.get(sid);
    await c.query(
      'INSERT INTO return_items(return_id, sale_item_id, product_id, qty, unit_price, base_price, cost_price) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [p.id, sid, si.product_id, qty.toFixed(3), si.unit_price, si.base_price, si.cost_price],
    );
    await moveStock(c, si.product_id, qty.times(si.unit_factor), 'return', p.id, p.reason, user.id, at);
  }
  await audit(c, user.id, 'return.create', 'return', p.id, {
    saleNumber: Number(sale.rows[0].number), total: fmt(total), refund: fmt(refund), refundMethod: p.refundMethod, debtReduction: fmt(debtReduction), reason: p.reason,
  });
  return { id: p.id, total: fmt(total), refund: fmt(refund), debtReduction: fmt(debtReduction) };
};

export async function debtRemaining(c: Client, debtId: string): Promise<Decimal> {
  const r = await c.query(
    `SELECT d.amount,
            coalesce((SELECT sum(amount) FROM debt_payments WHERE debt_id = d.id), 0) AS paid,
            coalesce((SELECT sum(debt_reduction) FROM returns WHERE sale_id = d.sale_id), 0) AS reduced
       FROM debts d WHERE d.id = $1`,
    [debtId],
  );
  const x = r.rows[0];
  return D(x.amount).minus(x.paid).minus(x.reduced);
}

// ---------------- NASIYA TO'LOVI ----------------
const debtPaymentSchema = z.object({
  id: zUuid, debtId: zUuid, amount: zPositiveMoney, method: z.enum(['cash', 'card', 'click']),
  note: zOptText(), createdAt: z.string().optional(),
});
const debtPaymentCreate: Handler = async ({ c, user }, payload) => {
  const p = parse(debtPaymentSchema, payload);
  const exists = await c.query('SELECT id FROM debt_payments WHERE id=$1', [p.id]);
  if (exists.rowCount) return { id: p.id };
  const d = await c.query('SELECT id FROM debts WHERE id=$1 FOR UPDATE', [p.debtId]);
  if (!d.rowCount) throw bad('Nasiya topilmadi');
  const remaining = await debtRemaining(c, p.debtId);
  if (D(p.amount).gt(remaining)) throw bad(`To‘lov qolgan qarzdan (${fmt(remaining)}) ko‘p bo‘lishi mumkin emas`);
  await c.query('INSERT INTO debt_payments(id, debt_id, amount, method, note, user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    p.id, p.debtId, p.amount, p.method, p.note, user.id, new Date(),
  ]);
  await audit(c, user.id, 'debt.payment', 'debt', p.debtId, { amount: p.amount, method: p.method });
  return { id: p.id, remaining: fmt(remaining.minus(p.amount)) };
};

// ---------------- XARAJATLAR ----------------
const expenseSchema = z.object({
  id: zUuid, name: zText(200).min(1, 'Xarajat nomini kiriting'), amount: zPositiveMoney, category: zOptText(100),
  expenseDate: zDate, note: zOptText(1000), paidFromCash: z.boolean().default(true), createdAt: z.string().optional(),
});
const expenseCreate: Handler = async ({ c, user }, payload) => {
  const p = parse(expenseSchema, payload);
  const exists = await c.query('SELECT id FROM expenses WHERE id=$1', [p.id]);
  if (exists.rowCount) return { id: p.id };
  if (p.expenseDate > todayStr()) throw bad('Kelajakdagi sana uchun xarajat kiritib bo‘lmaydi');
  await c.query(
    'INSERT INTO expenses(id, name, amount, category, expense_date, note, paid_from_cash, user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [p.id, p.name, p.amount, p.category, p.expenseDate, p.note, p.paidFromCash, user.id, new Date()],
  );
  await audit(c, user.id, 'expense.create', 'expense', p.id, { name: p.name, amount: p.amount, date: p.expenseDate });
  return { id: p.id };
};

const expenseDelete: Handler = async ({ c, user }, payload) => {
  assertAdmin(user);
  const p = parse(z.object({ id: zUuid, reason: zText(500).min(1, 'O‘chirish sababini yozing') }), payload);
  const r = await c.query('UPDATE expenses SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING name, amount, recurring_id, period_key', [p.id, user.id]);
  if (!r.rowCount) return { id: p.id };
  const e = r.rows[0];
  if (e.recurring_id) await c.query('DELETE FROM recurring_confirmations WHERE recurring_id=$1 AND period_key=$2', [e.recurring_id, e.period_key]);
  await audit(c, user.id, 'expense.delete', 'expense', p.id, { name: e.name, amount: e.amount, reason: p.reason });
  return { id: p.id };
};

// ---------------- DOIMIY XARAJATNI TASDIQLASH ----------------
const recurringConfirmSchema = z.object({
  id: zUuid, recurringId: zUuid, periodKey: zDate, amount: zPositiveMoney.optional(),
  paidFromCash: z.boolean().optional(), note: zOptText(1000), createdAt: z.string().optional(),
});
async function loadRecurringPeriod(c: Client, recurringId: string, periodKey: string) {
  const r = await c.query('SELECT * FROM recurring_expenses WHERE id=$1 FOR UPDATE', [recurringId]);
  if (!r.rowCount) throw bad('Doimiy xarajat topilmadi');
  const re = r.rows[0];
  const start = re.start_date instanceof Date ? re.start_date.toISOString().slice(0, 10) : String(re.start_date);
  if (periodKey > todayStr()) throw bad('Bu davr muddati hali kelmagan');
  if (!isDueDate(re.period, start, periodKey)) throw bad('Bu sana ushbu doimiy xarajatning muddat sanasi emas');
  const done = await c.query('SELECT status FROM recurring_confirmations WHERE recurring_id=$1 AND period_key=$2', [recurringId, periodKey]);
  if (done.rowCount) throw new AppError(409, done.rows[0].status === 'confirmed' ? 'Bu davr uchun xarajat allaqachon hisobga olingan' : 'Bu davr allaqachon o‘tkazib yuborilgan', 'duplicate');
  return re;
}
const recurringConfirm: Handler = async ({ c, user }, payload) => {
  const p = parse(recurringConfirmSchema, payload);
  const exists = await c.query('SELECT id FROM expenses WHERE id=$1', [p.id]);
  if (exists.rowCount) return { id: p.id };
  const re = await loadRecurringPeriod(c, p.recurringId, p.periodKey);
  const amount = p.amount ?? re.amount;
  const paidFromCash = p.paidFromCash ?? re.paid_from_cash;
  await c.query(
    `INSERT INTO expenses(id, name, amount, category, expense_date, note, paid_from_cash, recurring_id, period_key, user_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [p.id, re.name, amount, re.category ?? 'Doimiy', p.periodKey, p.note ?? re.note, paidFromCash, re.id, p.periodKey, user.id, new Date()],
  );
  await c.query('INSERT INTO recurring_confirmations(recurring_id, period_key, status, expense_id, user_id) VALUES ($1,$2,\'confirmed\',$3,$4)', [re.id, p.periodKey, p.id, user.id]);
  await audit(c, user.id, 'recurring.confirm', 'recurring_expense', re.id, { period: p.periodKey, amount });
  return { id: p.id };
};
const recurringSkip: Handler = async ({ c, user }, payload) => {
  const p = parse(z.object({ recurringId: zUuid, periodKey: zDate, note: zOptText() }), payload);
  const re = await loadRecurringPeriod(c, p.recurringId, p.periodKey);
  await c.query('INSERT INTO recurring_confirmations(recurring_id, period_key, status, user_id) VALUES ($1,$2,\'skipped\',$3)', [re.id, p.periodKey, user.id]);
  await audit(c, user.id, 'recurring.skip', 'recurring_expense', re.id, { period: p.periodKey, note: p.note });
  return { ok: true };
};

// ---------------- MAHSULOTLAR ----------------
const productFields = {
  name: zText(200).min(1, 'Mahsulot nomini kiriting'),
  categoryId: zUuid.nullable().optional(),
  code: zOptText(100),
  costPrice: zMoney,
  price: zMoney,
  discountPrice: zMoney.nullable().optional(),
  premiumPrice: zMoney.nullable().optional(),
  // Asosiy o'lchov birligi: qoldiq va tannarx shu birlikda
  unit: z.enum(['dona', 'kg', 'metr']).optional(),
  // Ikkinchi birlik (ixtiyoriy): masalan "qop", 1 qop = altFactor × asosiy birlik, o'z narxi altPrice
  altUnit: zOptText(30),
  altFactor: zQty.nullable().optional(),
  altPrice: zMoney.nullable().optional(),
  note: zOptText(1000),
  image: z.string().max(400_000).nullable().optional()
    .refine((v) => !v || /^data:image\/(jpeg|png|webp);base64,/.test(v), 'Rasm formati noto‘g‘ri'),
};
const productCreateSchema = z.object({
  id: zUuid, ...productFields,
  stock: z.union([z.string(), z.number()]).optional().nullable()
    .transform((v) => (v === undefined || v === null || String(v).trim() === '' ? '0' : String(v).trim().replace(',', '.')))
    .refine((v) => /^\d{1,10}(\.\d{1,3})?$/.test(v), 'Qoldiq noto‘g‘ri'),
});

/** Ikkinchi birlik maydonlari to'liq yoki butunlay bo'sh bo'lishi kerak. */
function checkAltUnit(unit: string, altUnit: string | null, altFactor: string | null, altPrice: string | null) {
  const filled = [altUnit, altFactor, altPrice].filter((v) => v !== null && v !== undefined).length;
  if (filled > 0 && filled < 3) throw bad('Ikkinchi birlik uchun nomi, nisbati va narxini to‘liq kiriting');
  if (altUnit && altUnit.toLowerCase() === unit) throw bad('Ikkinchi birlik asosiy birlikdan farq qilishi kerak');
  if (altFactor && unit === 'dona' && !D(altFactor).isInteger()) throw bad('Asosiy birlik "dona" bo‘lsa, nisbat butun son bo‘lishi kerak');
}

async function checkCode(c: Client, code: string | null | undefined, exceptId: string | null) {
  if (!code) return;
  const r = await c.query('SELECT name FROM products WHERE lower(code)=lower($1) AND NOT archived AND id <> coalesce($2::uuid, \'00000000-0000-0000-0000-000000000000\')', [code, exceptId]);
  if (r.rowCount) throw bad(`Bu kod "${r.rows[0].name}" mahsulotiga berilgan`);
}

const productCreate: Handler = async ({ c, user }, payload, opId) => {
  const p = parse(productCreateSchema, payload);
  const exists = await c.query('SELECT id FROM products WHERE id=$1', [p.id]);
  if (exists.rowCount) return { id: p.id };
  await checkCode(c, p.code, null);
  const unit = p.unit ?? 'dona';
  const alt = { unit: p.altUnit ?? null, factor: p.altFactor ?? null, price: p.altPrice ?? null };
  checkAltUnit(unit, alt.unit, alt.factor, alt.price);
  assertWhole(p.stock, unit, p.name);
  await c.query(
    `INSERT INTO products(id, name, category_id, code, cost_price, price, discount_price, premium_price, unit, alt_unit, alt_factor, alt_price,
                          note, image, image_version, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
    [p.id, p.name, p.categoryId ?? null, p.code, p.costPrice, p.price, p.discountPrice ?? null, p.premiumPrice ?? null, unit,
     alt.unit, alt.factor, alt.price, p.note, p.image ?? null, p.image ? 1 : 0, user.id],
  );
  if (D(p.stock).gt(0)) await moveStock(c, p.id, p.stock, 'initial', null, 'Boshlang‘ich qoldiq', user.id, new Date(), opId);
  await audit(c, user.id, 'product.create', 'product', p.id, {
    name: p.name, unit, costPrice: p.costPrice, price: p.price, discountPrice: p.discountPrice ?? null, premiumPrice: p.premiumPrice ?? null,
    altUnit: alt.unit, altFactor: alt.factor, altPrice: alt.price, stock: p.stock,
  });
  return { id: p.id };
};

const editable = ['name', 'categoryId', 'code', 'costPrice', 'price', 'discountPrice', 'premiumPrice', 'unit', 'altUnit', 'altFactor', 'altPrice', 'note', 'image'] as const;
type Editable = typeof editable[number];
const col: Record<Editable, string> = {
  name: 'name', categoryId: 'category_id', code: 'code', costPrice: 'cost_price', price: 'price', discountPrice: 'discount_price',
  premiumPrice: 'premium_price', unit: 'unit', altUnit: 'alt_unit', altFactor: 'alt_factor', altPrice: 'alt_price', note: 'note', image: 'image',
};
const partialFields = z.object(productFields).partial();
const productUpdateSchema = z.object({ id: zUuid, baseVersion: z.number().int(), before: z.record(z.any()).default({}), changes: partialFields });

function norm(k: Editable, v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (k === 'costPrice' || k === 'price' || k === 'discountPrice' || k === 'premiumPrice' || k === 'altPrice') return D(v as string).toFixed(2);
  if (k === 'altFactor') return D(v as string).toFixed(3);
  return String(v);
}

/**
 * Mahsulotni tahrirlash. Agar shu vaqt ichida boshqa foydalanuvchi aynan shu maydonlarni o'zgartirgan bo'lsa,
 * uning o'zgarishi jim ustidan yozilmaydi — foydalanuvchiga sahifani yangilash so'raladi.
 */
const productUpdate: Handler = async ({ c, user }, payload) => {
  const p = parse(productUpdateSchema, payload);
  const r = await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [p.id]);
  if (!r.rowCount) throw bad('Mahsulot topilmadi');
  const cur = r.rows[0];
  const keys = (Object.keys(p.changes) as Editable[]).filter((k) => editable.includes(k));
  if (!keys.length) return { id: p.id, version: cur.version };
  if (cur.version !== p.baseVersion) {
    const clashes = keys.filter((k) => k in p.before && norm(k, p.before[k]) !== norm(k, cur[col[k]]));
    if (clashes.length) {
      throw new AppError(409, 'Bu mahsulotni hozirgina boshqa foydalanuvchi o‘zgartirdi. Oynani yopib, qayta oching va o‘zgarishni takrorlang.', 'stale');
    }
  }
  await applyProductChanges(c, user, p.id, p.changes, cur);
  return { id: p.id };
};

export async function applyProductChanges(c: Client, user: AuthUser, id: string, changes: z.infer<typeof partialFields>, cur: any) {
  if (changes.code !== undefined) await checkCode(c, changes.code, id);
  // O'zgarishdan keyingi holat bo'yicha birliklarni tekshiramiz
  const pick = (k: Editable) => (k in changes ? ((changes as any)[k] ?? null) : cur[col[k]]);
  const unit = pick('unit') as string;
  checkAltUnit(unit, pick('altUnit'), pick('altFactor'), pick('altPrice'));
  if ('unit' in changes && unit === 'dona' && !D(cur.stock).isInteger()) {
    throw bad(`Qoldiq kasr son (${D(cur.stock).toString()}). Birlikni "dona"ga o‘zgartirishdan oldin qoldiqni tuzating.`);
  }
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const diff: Record<string, [unknown, unknown]> = {};
  for (const k of editable) {
    if (!(k in changes)) continue;
    const v = (changes as any)[k] ?? null;
    vals.push(v);
    sets.push(`${col[k]} = $${vals.length}`);
    if (k !== 'image') diff[k] = [cur[col[k]], v];
  }
  if ('image' in changes) sets.push('image_version = image_version + 1');
  vals.push(user.id);
  sets.push(`updated_by = $${vals.length}`, 'version = version + 1', 'updated_at = now()');
  await c.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, vals);
  await audit(c, user.id, 'product.update', 'product', id, diff);
}

const productArchive: Handler = async ({ c, user }, payload) => {
  assertAdmin(user);
  const p = parse(z.object({ id: zUuid, archived: z.boolean().default(true) }), payload);
  const r = await c.query('UPDATE products SET archived=$2, version = version + 1, updated_at = now() WHERE id=$1 RETURNING name, code', [p.id, p.archived]);
  if (!r.rowCount) throw bad('Mahsulot topilmadi');
  if (!p.archived) await checkCode(c, r.rows[0].code, p.id);
  await audit(c, user.id, p.archived ? 'product.archive' : 'product.restore', 'product', p.id, { name: r.rows[0].name });
  return { id: p.id };
};

// ---------------- OMBOR ----------------
// qty — asosiy birlikda (dona / kg / metr); tuzatishda manfiy bo'lishi mumkin
const stockSchema = z.object({
  id: zUuid, productId: zUuid,
  qty: z.union([z.string(), z.number()])
    .transform((v) => String(v).trim().replace(',', '.'))
    .refine((v) => /^-?\d{1,10}(\.\d{1,3})?$/.test(v) && !D(v).isZero(), 'Miqdor noto‘g‘ri yoki 0')
    .transform((v) => D(v).toFixed(3)),
  note: zOptText(500), createdAt: z.string().optional(),
});
async function checkStockUnit(c: Client, productId: string, qty: string) {
  const r = await c.query('SELECT name, unit FROM products WHERE id=$1', [productId]);
  if (!r.rowCount) throw bad('Mahsulot topilmadi');
  assertWhole(D(qty).abs().toFixed(3), r.rows[0].unit, r.rows[0].name);
}
const stockReceipt: Handler = async ({ c, user }, payload) => {
  const p = parse(stockSchema, payload);
  if (D(p.qty).lt(0)) throw bad('Kirim miqdori musbat bo‘lishi kerak');
  const ex = await c.query('SELECT id FROM inventory_movements WHERE id=$1', [p.id]);
  if (ex.rowCount) return { id: p.id };
  await checkStockUnit(c, p.productId, p.qty);
  const stock = await moveStock(c, p.productId, p.qty, 'receipt', null, p.note, user.id, new Date(), p.id);
  await audit(c, user.id, 'stock.receipt', 'product', p.productId, { qty: p.qty, note: p.note });
  return { id: p.id, stock };
};
const stockAdjust: Handler = async ({ c, user }, payload) => {
  const p = parse(stockSchema, payload);
  if (!p.note) throw bad('Tuzatish sababini yozing');
  const ex = await c.query('SELECT id FROM inventory_movements WHERE id=$1', [p.id]);
  if (ex.rowCount) return { id: p.id };
  await checkStockUnit(c, p.productId, p.qty);
  const stock = await moveStock(c, p.productId, p.qty, 'adjustment', null, p.note, user.id, new Date(), p.id);
  await audit(c, user.id, 'stock.adjust', 'product', p.productId, { delta: p.qty, note: p.note });
  return { id: p.id, stock };
};

export const handlers: Record<string, Handler> = {
  'sale.create': saleCreate,
  'return.create': returnCreate,
  'debtPayment.create': debtPaymentCreate,
  'expense.create': expenseCreate,
  'expense.delete': expenseDelete,
  'recurring.confirm': recurringConfirm,
  'recurring.skip': recurringSkip,
  'product.create': productCreate,
  'product.update': productUpdate,
  'product.archive': productArchive,
  'stock.receipt': stockReceipt,
  'stock.adjust': stockAdjust,
};

/** Bitta amalni idempotent tarzda bajaradi. */
export async function runOp(user: AuthUser, op: { id: string; type: string; payload?: unknown }, retry = true): Promise<OpResult> {
  const h = handlers[op.type];
  if (!h) return { opId: op.id, status: 'error', error: `Noma’lum amal: ${op.type}` };
  try {
    return await tx(async (c) => {
      const done = await c.query('SELECT result FROM processed_ops WHERE op_id=$1', [op.id]);
      if (done.rowCount) {
        return { opId: op.id, status: 'ok', result: done.rows[0].result } as OpResult;
      }
      const result = (await h({ c, user }, op.payload, op.id)) ?? null;
      await c.query('INSERT INTO processed_ops(op_id, op_type, result, user_id) VALUES ($1,$2,$3,$4)', [op.id, op.type, JSON.stringify(result), user.id]);
      return { opId: op.id, status: 'ok', result } as OpResult;
    });
  } catch (e: any) {
    if (e instanceof AppError) return { opId: op.id, status: 'error', error: e.message };
    // Bir xil amal parallel kelgan bo'lsa — qayta tekshirib, birinchisining natijasini qaytaramiz.
    if (e?.code === '23505' && retry) return runOp(user, op, false);
    if (e?.code === '23505') return { opId: op.id, status: 'error', error: 'Takroriy ma’lumot: bu yozuv allaqachon mavjud' };
    throw e;
  }
}
