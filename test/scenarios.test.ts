/**
 * Talablardagi test holatlari (backend qismi). Har bir test haqiqiy PostgreSQL bazada bajariladi.
 * Raqamlar qo'lda hisoblangan kutilgan qiymatlar bilan solishtiriladi.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uuid } from './helpers.ts';
import { todayStr } from '../src/util.ts';
import { dueDates } from '../src/services/recurring.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
const today = todayStr();
const P1 = uuid(); // Ko'ylak: tannarx 70 000, narx 100 000, chegirmali 90 000
const P2 = uuid(); // Shim: tannarx 50 000, narx 80 000
let A: string, S: string;

const stock = async (id: string) => Number((await t.call('GET', '/api/products', A)).body.find((p: any) => p.id === id).stock as string);
const rep = async () => (await t.call('GET', `/api/reports/summary?from=${today}&to=${today}`, A)).body;

before(async () => {
  t = await setupTestApp();
  A = t.adminToken;
  S = t.sellerToken;
});
after(async () => { await t.close(); });

test('1. Yangi mahsulot qo‘shish (3. tannarx alohida saqlanadi)', async () => {
  const r1 = await t.op(S, 'product.create', { id: P1, name: 'Ko‘ylak', code: 'KY-001', costPrice: '70000', price: '100000', discountPrice: '90000', stock: 10 });
  const r2 = await t.op(A, 'product.create', { id: P2, name: 'Шим', code: '4780000000017', costPrice: 50000, price: 80000, stock: 5 });
  assert.equal(r1.status, 'ok', r1.error);
  assert.equal(r2.status, 'ok', r2.error);
  const list = (await t.call('GET', '/api/products', A)).body;
  const p1 = list.find((p: any) => p.id === P1);
  assert.equal(p1.costPrice, '70000.00');
  assert.equal(p1.price, '100000.00');
  assert.equal(p1.discountPrice, '90000.00');
  assert.equal(p1.stock, '10');
  // Kirill nom o'zgartirilmasdan saqlanadi
  assert.equal(list.find((p: any) => p.id === P2).name, 'Шим');
  // Kod bo'yicha qidiruv
  const byCode = (await t.call('GET', '/api/products?q=4780000000017', S)).body;
  assert.equal(byCode.length, 1);
  // Bir xil kod takrorlanmaydi
  const dup = await t.op(S, 'product.create', { id: uuid(), name: 'X', code: 'ky-001', costPrice: 1, price: 2 });
  assert.equal(dup.status, 'error');
});

test('2. Mahsulot narxini o‘zgartirish (tarixdagi savdolar o‘zgarmaydi)', async () => {
  const list = (await t.call('GET', '/api/products', A)).body;
  const p2 = list.find((p: any) => p.id === P2);
  const r = await t.op(S, 'product.update', { id: P2, baseVersion: p2.version, before: { price: p2.price }, changes: { price: '85000' } });
  assert.equal(r.status, 'ok', r.error);
  const r2 = await t.op(S, 'product.update', { id: P2, baseVersion: p2.version + 1, before: { price: '85000' }, changes: { price: '80000' } });
  assert.equal(r2.status, 'ok', r2.error);
});

let saleCash: string, saleDebt: string, saleMixed: string;

test('4–8. Chegirmali narx, qo‘lda narx, naqd/karta/Click savdo', async () => {
  // 4. Chegirmali narxda (90 000) naqd: foyda 20 000
  saleCash = uuid();
  let r = await t.op(S, 'sale.create', { id: saleCash, items: [{ productId: P1, qty: 1, unitPrice: '90000' }], payments: [{ method: 'cash', amount: '90000' }] });
  assert.equal(r.status, 'ok', r.error);
  // 5. Sotuvchi belgilagan narx 95 000, karta: foyda 25 000
  r = await t.op(S, 'sale.create', { id: uuid(), items: [{ productId: P1, qty: 1, unitPrice: '95000' }], payments: [{ method: 'card', amount: '95000' }] });
  assert.equal(r.status, 'ok', r.error);
  // 8. Click, oddiy narx 2 dona shim: foyda 2 × 30 000 = 60 000
  r = await t.op(S, 'sale.create', { id: uuid(), items: [{ productId: P2, qty: 2, unitPrice: '80000' }], payments: [{ method: 'click', amount: '160000' }] });
  assert.equal(r.status, 'ok', r.error);
  // To'lov yig'indisi mos kelmasa — rad etiladi
  r = await t.op(S, 'sale.create', { id: uuid(), items: [{ productId: P1, qty: 1, unitPrice: '100000' }], payments: [{ method: 'cash', amount: '50000' }] });
  assert.equal(r.status, 'error');

  const s = await rep();
  assert.equal(s.grossSales, '345000.00');
  assert.equal(s.productProfit, '105000.00'); // 20 000 + 25 000 + 60 000
  assert.equal(s.discounts, '15000.00'); // 10 000 + 5 000
  assert.equal(s.income.cash, '90000.00');
  assert.equal(s.income.card, '95000.00');
  assert.equal(s.income.click, '160000.00');
});

test('Idempotentlik: bir savdo ikki marta yuborilsa, bir marta yoziladi', async () => {
  const before = await stock(P1);
  const id = uuid();
  const opId = uuid();
  const payload = { id, items: [{ productId: P1, qty: 1, unitPrice: '100000' }], payments: [{ method: 'cash', amount: '100000' }] };
  const [a, b] = await Promise.all([t.op(S, 'sale.create', payload, opId), t.op(S, 'sale.create', payload, opId)]);
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  // Boshqa op id bilan ham xuddi shu savdo — baribir bitta
  const c = await t.op(S, 'sale.create', payload);
  assert.equal(c.status, 'ok');
  assert.equal(await stock(P1), before - 1);
  const sales = (await t.call('GET', `/api/sales?from=${today}&to=${today}`, A)).body.filter((x: any) => x.id === id);
  assert.equal(sales.length, 1);
  // bu savdoni qaytarib, keyingi hisoblarni soddalashtiramiz
  const d = (await t.call('GET', `/api/sales/${id}`, A)).body;
  const r = await t.op(S, 'return.create', { id: uuid(), saleId: id, reason: 'Test', refundMethod: 'cash', items: [{ saleItemId: d.items[0].id, qty: 1 }] });
  assert.equal(r.status, 'ok', r.error);
});

test('9–10. Nasiya savdo va nasiya to‘lovi (aralash to‘lov)', async () => {
  // 3 dona ko'ylak × 100 000 = 300 000: 100 000 naqd + 200 000 nasiya
  saleDebt = uuid();
  let r = await t.op(S, 'sale.create', {
    id: saleDebt, items: [{ productId: P1, qty: 3, unitPrice: '100000' }],
    payments: [{ method: 'cash', amount: '100000' }, { method: 'debt', amount: '200000' }],
    customer: { name: 'Alisher', phone: '+998901234567' }, note: 'Oy oxirida to‘laydi',
  });
  assert.equal(r.status, 'ok', r.error);
  // Ismsiz nasiya rad etiladi
  r = await t.op(S, 'sale.create', { id: uuid(), items: [{ productId: P1, qty: 1, unitPrice: '100000' }], payments: [{ method: 'debt', amount: '100000' }] });
  assert.equal(r.status, 'error');

  let s = await rep();
  assert.equal(s.debtSales, '200000.00');
  // Nasiya qismi naqd tushumga kirmagan: 90 000 + 100 000 (qaytarilgan test savdosi 100 000 kirib-chiqdi)
  assert.equal(s.income.cash, '190000.00');

  const debts = (await t.call('GET', '/api/debts', S)).body;
  const debt = debts.find((d: any) => d.saleId === saleDebt);
  assert.equal(debt.remaining, '200000.00');
  assert.equal(debt.customerPhone, '+998901234567');

  r = await t.op(S, 'debtPayment.create', { id: uuid(), debtId: debt.id, amount: '50000', method: 'card' });
  assert.equal(r.status, 'ok', r.error);
  // Qarzdan ko'p to'lov rad etiladi
  r = await t.op(S, 'debtPayment.create', { id: uuid(), debtId: debt.id, amount: '999999', method: 'cash' });
  assert.equal(r.status, 'error');
  const d2 = (await t.call('GET', `/api/debts/${debt.id}`, S)).body;
  assert.equal(d2.paid, '50000.00');
  assert.equal(d2.remaining, '150000.00');
  s = await rep();
  assert.equal(s.income.card, '145000.00'); // 95 000 + 50 000 nasiya to'lovi
});

test('12. Qisman qaytarish (nasiya savdodan 1 dona)', async () => {
  const sale = (await t.call('GET', `/api/sales/${saleDebt}`, S)).body;
  const before = await stock(P1);
  const pBefore = (await rep()).productProfit;
  const r = await t.op(S, 'return.create', { id: uuid(), saleId: saleDebt, reason: 'O‘lchami to‘g‘ri kelmadi', refundMethod: 'cash', items: [{ saleItemId: sale.items[0].id, qty: 1 }] });
  assert.equal(r.status, 'ok', r.error);
  // 100 000 qaytdi: avval qolgan qarz (150 000) kamayadi, pul qaytarilmaydi
  assert.equal(r.result.debtReduction, '100000.00');
  assert.equal(r.result.refund, '0.00');
  assert.equal(await stock(P1), before + 1);
  const s = await rep();
  assert.equal(Number(s.productProfit), Number(pBefore) - 30000);
  const debt = (await t.call('GET', '/api/debts?status=all', S)).body.find((d: any) => d.saleId === saleDebt);
  assert.equal(debt.remaining, '50000.00');
  // Ortiqcha qaytarish rad etiladi (3 tadan 1 qaytgan, 3 ta so'ralsa)
  const bad = await t.op(S, 'return.create', { id: uuid(), saleId: saleDebt, reason: 'x', items: [{ saleItemId: sale.items[0].id, qty: 3 }] });
  assert.equal(bad.status, 'error');
  // Asl savdo tarixda qoladi
  const after = (await t.call('GET', `/api/sales/${saleDebt}`, S)).body;
  assert.equal(after.items[0].qty, '3');
  assert.equal(after.items[0].returnedQty, '1');
  assert.equal(after.returns.length, 1);
});

test('11. To‘liq qaytarish (naqd savdo)', async () => {
  const sale = (await t.call('GET', `/api/sales/${saleCash}`, S)).body;
  const before = await stock(P1);
  const s0 = await rep();
  const r = await t.op(S, 'return.create', { id: uuid(), saleId: saleCash, reason: 'Nuqsonli', refundMethod: 'cash', items: sale.items.map((i: any) => ({ saleItemId: i.id, qty: i.qty })) });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.result.refund, '90000.00');
  assert.equal(await stock(P1), before + 1);
  const s = await rep();
  assert.equal(Number(s.income.cash), Number(s0.income.cash) - 90000);
  assert.equal(Number(s.productProfit), Number(s0.productProfit) - 20000);
  assert.equal(Number(s.discounts), Number(s0.discounts) - 10000);
});

test('13–14. Qoldiq to‘g‘ri o‘zgaradi, tugaganda 0 yoki manfiy bo‘ladi', async () => {
  // Ko'ylak: 10 boshlang'ich − 1 − 1 − 1(test) + 1(test qaytdi) − 3 + 1 + 1 = 7
  assert.equal(await stock(P1), 7);
  // Shim: 5 − 2 = 3. Hammasini sotamiz → 0 (ERR)
  saleMixed = uuid();
  const r = await t.op(S, 'sale.create', { id: saleMixed, items: [{ productId: P2, qty: 3, unitPrice: '80000' }], payments: [{ method: 'cash', amount: '200000' }, { method: 'click', amount: '40000' }] });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(await stock(P2), 0);
  const dash = (await t.call('GET', '/api/dashboard', S)).body;
  assert.equal(dash.stock.outOfStock, 1);
  // Ombor tarixida har bir harakat bor
  const mv = (await t.call('GET', `/api/inventory/movements?productId=${P2}`, S)).body;
  assert.deepEqual(mv.map((m: any) => Number(m.delta)).reverse(), [5, -2, -3]);
  // Kirim (sabab bilan)
  const rc = await t.op(S, 'stock.receipt', { id: uuid(), productId: P2, qty: 4, note: 'Yetkazib beruvchidan' });
  assert.equal(rc.status, 'ok', rc.error);
  assert.equal(await stock(P2), 4);
  // Sababsiz tuzatish rad etiladi
  const adj = await t.op(S, 'stock.adjust', { id: uuid(), productId: P2, qty: -1 });
  assert.equal(adj.status, 'error');
});

let recId: string;
test('15–16. Oddiy xarajat va izoh', async () => {
  const r = await t.op(S, 'expense.create', { id: uuid(), name: 'Tushlik', amount: '50000', category: 'Ovqat', expenseDate: today, note: 'Sotuvchilar uchun', paidFromCash: true });
  assert.equal(r.status, 'ok', r.error);
  const r2 = await t.op(A, 'expense.create', { id: uuid(), name: 'Transport', amount: '30000', expenseDate: today, paidFromCash: false });
  assert.equal(r2.status, 'ok', r2.error);
  const list = (await t.call('GET', `/api/expenses?from=${today}&to=${today}`, S)).body;
  const lunch = list.find((e: any) => e.name === 'Tushlik');
  assert.equal(lunch.note, 'Sotuvchilar uchun');
  assert.equal(lunch.userName, 'Sotuvchi');
  assert.ok(lunch.createdAt);
});

test('17–20. Doimiy xarajat: yaratish, tasdiqlash, tasdiqlanmagani foydaga ta’sir qilmaydi, ikki marta hisoblanmaydi', async () => {
  const s0 = await rep();
  const r = await t.call('POST', '/api/recurring', S, { name: 'Sotuvchi kunlik maoshi', amount: '200000', period: 'daily', startDate: today, paidFromCash: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  recId = r.body.id;
  // 19. Tasdiqlanmagan — sof foyda o'zgarmaydi
  let s = await rep();
  assert.equal(s.netProfit, s0.netProfit);
  const pending = (await t.call('GET', '/api/recurring/pending', S)).body.filter((p: any) => p.recurringId === recId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].periodKey, today);
  // 18. Tasdiqlash
  const c1 = await t.op(S, 'recurring.confirm', { id: uuid(), recurringId: recId, periodKey: today });
  assert.equal(c1.status, 'ok', c1.error);
  s = await rep();
  assert.equal(s.expenses.recurring, '200000.00');
  assert.equal(Number(s.netProfit), Number(s0.netProfit) - 200000);
  // 20. Ikkinchi marta — rad etiladi (boshqa qurilmadan ham)
  const c2 = await t.op(A, 'recurring.confirm', { id: uuid(), recurringId: recId, periodKey: today });
  assert.equal(c2.status, 'error');
  s = await rep();
  assert.equal(s.expenses.recurring, '200000.00');
  // Muddat sanasi bo'lmagan kunni tasdiqlab bo'lmaydi
  const c3 = await t.op(A, 'recurring.confirm', { id: uuid(), recurringId: recId, periodKey: '2000-01-01' });
  assert.equal(c3.status, 'error');
});

test('Oylik davr sanalari (31-sanadan boshlansa, fevralda 28/29)', () => {
  assert.deepEqual(dueDates('monthly', '2026-01-31', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(dueDates('weekly', '2026-11-01', '2026-11-20'), ['2026-11-01', '2026-11-08', '2026-11-15']);
});

test('21–22. Kunlik foyda va sof foyda formulasi', async () => {
  const s = await rep();
  // Sotilgan (qaytarilganlardan keyin):
  //  ko'ylak 95 000 (karta): foyda 25 000
  //  shim 2×80 000 (Click): 60 000
  //  nasiya savdo: 3×100 000, 1 tasi qaytgan → 2×30 000 = 60 000
  //  shim 3×80 000 (aralash): 90 000
  assert.equal(s.productProfit, '235000.00');
  // Xarajatlar: 50 000 + 30 000 oddiy, 200 000 doimiy
  assert.equal(s.expenses.regular, '80000.00');
  assert.equal(s.expenses.recurring, '200000.00');
  assert.equal(s.netProfit, '-45000.00'); // 235 000 − 80 000 − 200 000
  // Sof savdo: 345 000 + 100 000(test) + 300 000 + 240 000 − 100 000(test) − 100 000 − 90 000
  assert.equal(s.netSales, '695000.00');
  const sh = s.products.find((p: any) => p.productId === P2);
  assert.equal(sh.netQty, '5');
});

test('23–24. Kunlik va oylik hisobot', async () => {
  const month = today.slice(0, 8) + '01';
  const m = (await t.call('GET', `/api/reports/summary?from=${month}&to=${today}`, A)).body;
  const d = await rep();
  assert.equal(m.netProfit, d.netProfit);
  assert.equal(m.products.length, 2);
  const days = (await t.call('GET', `/api/reports/daily?from=${month}&to=${today}`, A)).body;
  assert.equal(days.at(-1).netProfit, d.netProfit);
  // Noto'g'ri oraliq
  const bad = await t.call('GET', `/api/reports/summary?from=${today}&to=2000-01-01`, A);
  assert.equal(bad.status, 400);
});

test('25–26. Smenani yopish va kassa solishtiruvi', async () => {
  const pv = (await t.call('GET', `/api/closings/preview?date=${today}`, S)).body;
  // Kassa = 0 (boshlang'ich) + naqd tushum − kassadan to'langan xarajatlar
  // naqd: 90 000 + 100 000 + 100 000 + 200 000 − 100 000 − 90 000 = 300 000
  assert.equal(pv.summary.income.cash, '300000.00');
  // kassadan: tushlik 50 000 + maosh 200 000 (transport kassadan emas)
  assert.equal(pv.summary.cashExpenses, '250000.00');
  assert.equal(pv.expectedCash, '50000.00');
  const r = await t.call('POST', '/api/closings', S, { date: today, openingCash: '100000', actualCash: '140000', note: 'Smena yakuni' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.expectedCash, '150000.00');
  assert.equal(r.body.difference, '-10000.00'); // kamomad
  // Ikkinchi marta yopish — sotuvchiga ruxsat yo'q
  const again = await t.call('POST', '/api/closings', S, { date: today, openingCash: '100000', actualCash: '150000' });
  assert.equal(again.status, 409);
  const again2 = await t.call('POST', '/api/closings', S, { date: today, openingCash: '100000', actualCash: '150000', overwrite: true });
  assert.equal(again2.status, 403);
  const admin = await t.call('POST', '/api/closings', A, { date: today, openingCash: '100000', actualCash: '160000', overwrite: true });
  assert.equal(admin.body.difference, '10000.00'); // ortiqcha
  const list = (await t.call('GET', '/api/closings', S)).body;
  assert.equal(list.length, 1);
});

test('Bir vaqtda tahrirlash: boshqa foydalanuvchining o‘zgarishi jim ustidan yozilmaydi', async () => {
  const p = (await t.call('GET', '/api/products', A)).body.find((x: any) => x.id === P1);
  const a = await t.op(S, 'product.update', { id: P1, baseVersion: p.version, before: { price: p.price }, changes: { price: '110000' } });
  assert.equal(a.status, 'ok');
  // Ikkinchi foydalanuvchi eski oynada narxni o'zgartiradi → rad etiladi, birinchisining narxi saqlanadi
  const b = await t.op(A, 'product.update', { id: P1, baseVersion: p.version, before: { price: p.price }, changes: { price: '105000' } });
  assert.equal(b.status, 'error');
  // Boshqa maydon (izoh) o'zgarsa — to'qnashuv yo'q, qo'llanadi
  const c = await t.op(A, 'product.update', { id: P1, baseVersion: p.version, before: { note: p.note }, changes: { note: 'Yangi izoh' } });
  assert.equal(c.status, 'ok', c.error);
  const after = (await t.call('GET', '/api/products', A)).body.find((x: any) => x.id === P1);
  assert.equal(after.price, '110000.00');
  assert.equal(after.note, 'Yangi izoh');
  // Offline yo'llari olib tashlangan
  assert.equal((await t.call('GET', '/api/sync/snapshot', A)).status, 404);
});

test('Xavfsizlik: tokensiz kirish yo‘q, sotuvchi foydalanuvchi qo‘sha olmaydi, xarajatni o‘chira olmaydi', async () => {
  assert.equal((await t.call('GET', '/api/products')).status, 401);
  assert.equal((await t.call('POST', '/api/users', S, { username: 'x1x', fullName: 'X', password: '123456', role: 'admin' })).status, 403);
  const e = (await t.call('GET', `/api/expenses?from=${today}&to=${today}`, S)).body[0];
  const del = await t.op(S, 'expense.delete', { id: e.id, reason: 'xato' });
  assert.equal(del.status, 'error');
  const login = await t.call('POST', '/api/auth/login', undefined, { username: 'admin', password: 'noto‘g‘ri' });
  assert.equal(login.status, 401);
  // Parol xeshi hech qachon qaytarilmaydi
  const users = (await t.call('GET', '/api/users', A)).body;
  assert.ok(users.every((u: any) => !('password_hash' in u) && !('passwordHash' in u)));
});
