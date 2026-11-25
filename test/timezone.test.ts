/** APP_TIMEZONE har xil yozilganda ham server ishlashi (bosh sahifa "bugun"ni hisoblay olishi). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimezone } from '../src/config.ts';

test('resolveTimezone: to‘g‘ri, ofsetli va noto‘g‘ri qiymatlar', () => {
  assert.equal(resolveTimezone(undefined), 'Asia/Tashkent');
  assert.equal(resolveTimezone(''), 'Asia/Tashkent');
  assert.equal(resolveTimezone('Asia/Tashkent'), 'Asia/Tashkent');
  assert.equal(resolveTimezone('"Asia/Tashkent"'), 'Asia/Tashkent');
  // Ofset ko'rinishidagi yozuvlar → IANA nomi (ishora teskari)
  for (const v of ['UTC+5', 'GMT+5', 'utc+05:00', '+5', '+05', 'UTC +5']) assert.equal(resolveTimezone(v), 'Etc/GMT-5', v);
  assert.equal(resolveTimezone('UTC-3'), 'Etc/GMT+3');
  assert.equal(resolveTimezone('UTC'), 'UTC');
  // Tushunarsiz qiymat — standart mintaqa
  assert.equal(resolveTimezone('Toshkent'), 'Asia/Tashkent');
  assert.equal(resolveTimezone('UTC+5:30'), 'Asia/Tashkent');
});

test('Natijaviy nom JavaScript sana formatida ishlaydi', () => {
  for (const v of ['UTC+5', 'Asia/Tashkent', 'noto‘g‘ri']) {
    const tz = resolveTimezone(v);
    assert.match(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()), /^\d{4}-\d{2}-\d{2}$/);
  }
});
