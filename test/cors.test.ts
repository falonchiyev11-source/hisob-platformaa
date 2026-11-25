/** CORS_ORIGIN sozlamasidagi mayda farqlar (oxiridagi "/", yo'l, qo'shtirnoq, katta harf) ruxsatga xalaqit bermasligi. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrigin } from '../src/config.ts';

test('normalizeOrigin: turli yozilishlar bir xil manzilga keltiriladi', () => {
  const want = 'https://hisob-platforma.vercel.app';
  for (const v of [
    'https://hisob-platforma.vercel.app',
    'https://hisob-platforma.vercel.app/',
    'https://hisob-platforma.vercel.app//',
    'https://Hisob-Platforma.Vercel.App/',
    '  https://hisob-platforma.vercel.app/login  ',
    '"https://hisob-platforma.vercel.app/"',
    "'https://hisob-platforma.vercel.app'",
    'hisob-platforma.vercel.app',
  ]) assert.equal(normalizeOrigin(v), want, v);
  assert.equal(normalizeOrigin('http://localhost:5173/'), 'http://localhost:5173');
  assert.equal(normalizeOrigin(''), '');
});
