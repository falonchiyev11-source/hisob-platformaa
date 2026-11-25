/**
 * O'lchov birliklari (dona / kg / metr), ikkinchi birlik (nisbat bilan) va premium narx.
 * Misol: sement — asosiy birlik kg, ikkinchi birlik qop (1 qop = 50 kg).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uuid } from './helpers.ts';
import { todayStr } from '../src/util.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let A: string;
const today = todayStr();
const CEMENT = uuid(); // kg, tannarx 1 000/kg, narx 1 400/kg, premium 1 300/kg; qop = 50 kg, qop narxi 65 000
const CABLE = uuid(); // metr, tannarx 3 000, narx 5 000
const CUP = uuid(); // dona

const product = async (id: string) => (await t.call('GET', '/api/products', A)).body.find((p: any) => p.id === id);
const rep = async () => (await t.call('GET', `/api/reports/summary?from=${today}&to=${today}`, A)).body;

before(async () => { t = await setupTestApp(); A = t.adminToken; });
after(async () => { await t.close(); });

test('Mahsulot: birlik, ikkinchi birlik va premium narx saqlanadi', async () => {
  let r = await t.op(A, 'product.create', {
    id: CEMENT, name: 'Sement M400', unit: 'kg', costPrice: '1000', price: '1400', premiumPrice: '1300',
    altUnit: 'qop', altFactor: '50', altPrice: '65000', stock: '500',
  });
  assert.equal(r.status, 'ok', r.error);
  r = await t.op(A, 'product.create', { id: CABLE, name: 'Kabel 2x1.5', unit: 'metr', costPrice: '3000', price: '5000', stock: '100.5' });
  assert.equal(r.status, 'ok', r.error);
  r = await t.op(A, 'product.create', { id: CUP, name: 'Piyola', unit: 'dona', costPrice: '5000', price: '8000', premiumPrice: '7000', stock: 10 });
  assert.equal(r.status, 'ok', r.error);

  const c = await product(CEMENT);
  assert.equal(c.unit, 'kg');
  assert.equal(c.altUnit, 'qop');
  assert.equal(c.altFactor, '50');
  assert.equal(c.altPrice, '65000.00');
  assert.equal(c.premiumPrice, '1300.00');
  assert.equal(c.stock, '500');
  assert.equal((await product(CABLE)).stock, '100.5');
});

test('Noto‘g‘ri birlik ma’lumotlari rad etiladi', async () => {
  // Dona mahsulotning boshlang'ich qoldig'i kasr bo'lmaydi
  let r = await t.op(A, 'product.create', { id: uuid(), name: 'X', unit: 'dona', costPrice: 1, price: 2, stock: '1.5' });
  assert.equal(r.status, 'error');
  // Ikkinchi birlik to'liq emas (nisbat yo'q)
  r = await t.op(A, 'product.create', { id: uuid(), name: 'Y', unit: 'kg', costPrice: 1, price: 2, altUnit: 'qop', altPrice: '100' });
  assert.equal(r.status, 'error');
  // Dona mahsulotni kasr miqdorda sotib bo'lmaydi
  r = await t.op(A, 'sale.create', { id: uuid(), items: [{ productId: CUP, qty: '1.5', unitPrice: '8000' }], payments: [{ method: 'cash', amount: '12000' }] });
  assert.equal(r.status, 'error');
  // Ikkinchi birligi yo'q mahsulotni ikkinchi birlikda sotib bo'lmaydi
  r = await t.op(A, 'sale.create', { id: uuid(), items: [{ productId: CABLE, unit: 'alt', qty: 1, unitPrice: '5000' }], payments: [{ method: 'cash', amount: '5000' }] });
  assert.equal(r.status, 'error');
});

test('Kasr miqdorda va premium narxda savdo (kg, metr)', async () => {
  const s0 = await rep();
  // 2,5 kg sement premium narxda: 2,5 × 1 300 = 3 250; foyda 2,5 × 300 = 750
  // 3,25 metr kabel oddiy narxda: 3,25 × 5 000 = 16 250; foyda 3,25 × 2 000 = 6 500
  const r = await t.op(A, 'sale.create', {
    id: uuid(),
    items: [{ productId: CEMENT, qty: '2.5', unitPrice: '1300' }, { productId: CABLE, qty: '3.25', unitPrice: '5000' }],
    payments: [{ method: 'cash', amount: '19500' }],
  });
  assert.equal(r.status, 'ok', r.error);
  assert.equal((await product(CEMENT)).stock, '497.5');
  assert.equal((await product(CABLE)).stock, '97.25');
  const s = await rep();
  assert.equal(Number(s.productProfit) - Number(s0.productProfit), 7250);
  // Premium narx chegirma sifatida ko'rinadi: 2,5 × (1 400 − 1 300) = 250
  assert.equal(Number(s.discounts) - Number(s0.discounts), 250);
});

let qopSale: string;
test('Ikkinchi birlikda (qopda) savdo: ombordan nisbat bo‘yicha kamayadi', async () => {
  const s0 = await rep();
  const before = Number((await product(CEMENT)).stock);
  qopSale = uuid();
  // 2 qop × 65 000 = 130 000; ombordan 2 × 50 = 100 kg; tannarx 100 × 1 000 = 100 000; foyda 30 000
  const r = await t.op(A, 'sale.create', {
    id: qopSale, items: [{ productId: CEMENT, unit: 'alt', qty: 2, unitPrice: '65000' }], payments: [{ method: 'card', amount: '130000' }],
  });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(Number((await product(CEMENT)).stock), before - 100);
  const s = await rep();
  assert.equal(Number(s.productProfit) - Number(s0.productProfit), 30000);
  const sale = (await t.call('GET', `/api/sales/${qopSale}`, A)).body;
  assert.equal(sale.items[0].unitName, 'qop');
  assert.equal(sale.items[0].qty, '2');
  // Hisobotda sement miqdori asosiy birlikda (kg): 2,5 + 100
  const cem = s.products.find((p: any) => p.productId === CEMENT);
  assert.equal(cem.unit, 'kg');
  assert.equal(cem.soldQty, '102.5');
});

test('Qopda sotilganni qaytarish: omborga 50 kg qaytadi, foyda qayta hisoblanadi', async () => {
  const s0 = await rep();
  const before = Number((await product(CEMENT)).stock);
  const sale = (await t.call('GET', `/api/sales/${qopSale}`, A)).body;
  const r = await t.op(A, 'return.create', { id: uuid(), saleId: qopSale, reason: 'Ortib qoldi', refundMethod: 'card', items: [{ saleItemId: sale.items[0].id, qty: 1 }] });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.result.refund, '65000.00');
  assert.equal(Number((await product(CEMENT)).stock), before + 50);
  const s = await rep();
  assert.equal(Number(s0.productProfit) - Number(s.productProfit), 15000);
  // Qopni yarimta qaytarib bo'lmaydi
  const bad = await t.op(A, 'return.create', { id: uuid(), saleId: qopSale, reason: 'x', items: [{ saleItemId: sale.items[0].id, qty: '0.5' }] });
  assert.equal(bad.status, 'error');
});

test('Ombor: kg mahsulotga kasr kirim, dona mahsulotga faqat butun', async () => {
  let r = await t.op(A, 'stock.receipt', { id: uuid(), productId: CABLE, qty: '12.75', note: 'Kirim' });
  assert.equal(r.status, 'ok', r.error);
  assert.equal((await product(CABLE)).stock, '110');
  r = await t.op(A, 'stock.receipt', { id: uuid(), productId: CUP, qty: '0.5', note: 'Kirim' });
  assert.equal(r.status, 'error');
});

test('Mahsulotni tahrirlash: premium narx va ikkinchi birlik qo‘shiladi/olib tashlanadi', async () => {
  let p = await product(CABLE);
  let r = await t.op(A, 'product.update', {
    id: CABLE, baseVersion: p.version, before: {},
    changes: { premiumPrice: '4500', altUnit: 'rulon', altFactor: '100', altPrice: '480000' },
  });
  assert.equal(r.status, 'ok', r.error);
  p = await product(CABLE);
  assert.equal(p.premiumPrice, '4500.00');
  assert.equal(p.altUnit, 'rulon');
  r = await t.op(A, 'product.update', { id: CABLE, baseVersion: p.version, before: {}, changes: { altUnit: null, altFactor: null, altPrice: null } });
  assert.equal(r.status, 'ok', r.error);
  assert.equal((await product(CABLE)).altUnit, null);
  // Faqat nomini olib tashlash (nisbat qolsa) — rad etiladi
  p = await product(CEMENT);
  r = await t.op(A, 'product.update', { id: CEMENT, baseVersion: p.version, before: {}, changes: { altUnit: null } });
  assert.equal(r.status, 'error');
});
