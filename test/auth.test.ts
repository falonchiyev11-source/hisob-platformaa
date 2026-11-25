/** Do'kon nomi bilan kirish: bo'sh joy, kirill, apostrof; katta-kichik harf farq qilmaydi. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.ts';

let t: Awaited<ReturnType<typeof setupTestApp>>;
before(async () => { t = await setupTestApp(); });
after(async () => { await t.close(); });

const login = (username: string, password: string) => t.call('POST', '/api/auth/login', undefined, { username, password });

test('Nom bilan kirish: katta-kichik harf va ortiqcha bo‘sh joy farq qilmaydi', async () => {
  assert.equal((await login('ADMIN', 'admin123')).status, 200);
  assert.equal((await login('  admin  ', 'admin123')).status, 200);
  const bad = await login('admin', 'notogri');
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /Do‘kon nomi yoki parol/);
});

test('Do‘kon nomi bo‘sh joy, apostrof va kirill harflari bilan', async () => {
  let r = await t.call('POST', '/api/users', t.adminToken, { username: 'Ali   do‘koni', fullName: 'Ali do‘koni', password: 'parol123', role: 'admin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.username, 'Ali do‘koni');
  assert.equal((await login('ali DO‘KONI', 'parol123')).status, 200);

  r = await t.call('POST', '/api/users', t.adminToken, { username: 'Нодира магазин', fullName: 'Нодира', password: 'parol123', role: 'seller' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await login('нодира МАГАЗИН', 'parol123')).status, 200);

  // Faqat harf kattaligi bilan farq qiladigan nom — band
  r = await t.call('POST', '/api/users', t.adminToken, { username: 'ALI DO‘KONI', fullName: 'X', password: 'parol123', role: 'seller' });
  assert.equal(r.status, 400);
  // Juda qisqa nom
  r = await t.call('POST', '/api/users', t.adminToken, { username: 'A', fullName: 'X', password: 'parol123', role: 'seller' });
  assert.equal(r.status, 400);
});

test('Tizim sozlangandan keyin qayta sozlab bo‘lmaydi', async () => {
  const r = await t.call('POST', '/api/setup', undefined, { username: 'Boshqa do‘kon', password: 'parol123' });
  assert.equal(r.status, 409);
});
