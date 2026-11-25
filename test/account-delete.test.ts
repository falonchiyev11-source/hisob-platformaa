/** Akkauntni o'chirish: hamma ma'lumot o'chadi, qayta tiklanmaydi, yangi akkaunt ochish mumkin bo'ladi. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp, uuid } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
before(async () => { t = await setupTestApp(); });
after(async () => { await t.close(); });

test('Akkauntni o‘chirish: tasdiqsiz yoki sotuvchi tomonidan — rad etiladi', async () => {
  const P = uuid();
  const r = await t.op(t.adminToken, 'product.create', { id: P, name: 'Non', costPrice: 1000, price: 2000, stock: 10 });
  assert.equal(r.status, 'ok', r.error);
  const s = await t.op(t.adminToken, 'sale.create', { id: uuid(), items: [{ productId: P, qty: 1, unitPrice: '2000' }], payments: [{ method: 'cash', amount: '2000' }] });
  assert.equal(s.status, 'ok', s.error);

  // Tasdiqlash so'zisiz yoki noto'g'ri so'z bilan
  for (const confirm of ['', 'ha', 'xayr', 'hayr']) {
    assert.equal((await t.call('POST', '/api/account/delete', t.adminToken, { confirm })).status, 400, confirm);
  }
  // Sotuvchi o'chira olmaydi
  assert.equal((await t.call('POST', '/api/account/delete', t.sellerToken, { confirm: 'hayir' })).status, 403);
  // Tokensiz — yo'q
  assert.equal((await t.call('POST', '/api/account/delete', undefined, { confirm: 'hayir' })).status, 401);
  // Hech narsa o'chmagan
  assert.equal((await t.call('GET', '/api/products', t.adminToken)).body.length, 1);
});

test('Akkauntni o‘chirish: "Hayir" bilan hammasi o‘chadi, keyin yangi akkaunt ochiladi', async () => {
  const r = await t.call('POST', '/api/account/delete', t.adminToken, { confirm: '  Hayir ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Platforma yana ro'yxatdan o'tishni so'raydi
  assert.deepEqual((await t.call('GET', '/api/setup/status')).body, { needsSetup: true });
  // Eski token endi ishlamaydi, eski nom/parol bilan kirib bo'lmaydi
  assert.equal((await t.call('GET', '/api/products', t.adminToken)).status, 401);
  assert.equal((await t.call('POST', '/api/auth/login', undefined, { username: 'admin', password: 'admin123' })).status, 401);

  // Yangi do'kon nomi va parol bilan yangi akkaunt — bo'sh holatda
  const s = await t.call('POST', '/api/setup', undefined, { username: 'Yangi do‘kon', password: 'yangi123' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const tok = s.body.token;
  assert.equal((await t.call('GET', '/api/products', tok)).body.length, 0);
  assert.equal((await t.call('GET', '/api/sales', tok)).body.length, 0);
  const dash = (await t.call('GET', '/api/dashboard', tok)).body;
  assert.equal(dash.summary.salesCount, 0);
  // Savdo raqamlari ham boshidan boshlanadi
  const P = (await t.op(tok, 'product.create', { id: uuid(), name: 'Choy', costPrice: 1, price: 2, stock: 1 }));
  assert.equal(P.status, 'ok', P.error);
});

test('Kirillcha tasdiqlash so‘zi ham qabul qilinadi', async () => {
  const s = await t.call('POST', '/api/auth/login', undefined, { username: 'yangi do‘kon', password: 'yangi123' });
  const r = await t.call('POST', '/api/account/delete', s.body.token, { confirm: 'ҲАЙИР' });
  assert.equal(r.status, 200);
  assert.deepEqual((await t.call('GET', '/api/setup/status')).body, { needsSetup: true });
});
