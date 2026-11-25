# hisob-platforma-bachand

Savdo va ombor boshqaruv platformasining backend qismi (server). Frontend: [hisob-platforma](https://github.com/f93142122-tech/hisob-platforma).

**Texnologiyalar:** Node.js, Fastify, PostgreSQL, Zod (validatsiya), bcrypt (parollar), JWT (kirish). Pul qiymatlari `NUMERIC(15,2)` va `decimal.js` bilan hisoblanadi, float ishlatilmaydi.

## Ishga tushirish

Node.js 22 yoki undan yangi versiya kerak.

```powershell
npm install
npm run setup
npm start
```

- `npm run setup` `.env` faylini yaratadi va maxfiy kalitlarni o'zi to'ldiradi.
- `LOCAL_DB=true` bo'lsa (Windows), PostgreSQL loyiha ichidan avtomatik ishga tushadi. Ma'lumotlar `DATA_DIR` papkasida saqlanadi.
- Tashqi PostgreSQL ishlatish uchun `.env` faylida `LOCAL_DB=false` qiling va `DATABASE_URL` ni kiriting.
- Jadvallar (migratsiyalar) server ishga tushganda avtomatik yaratiladi.
- Frontend build papkasi `WEB_DIST` da ko'rsatilsa, server uni o'zi ham beradi. Frontend alohida domenda joylashsa, `CORS_ORIGIN` ga uning manzilini yozing.

## Testlar

```powershell
npm test
```

Testlar alohida `savdo_test` bazasida ishlaydi va ishchi ma'lumotlarga tegmaydi. Ular savdo, chegirma, nasiya, qaytarish, foyda va sof foyda, doimiy xarajatlar, kassa solishtiruvi, idempotentlik va bir vaqtda tahrirlashni tekshiradi.

## Tuzilishi

- `migrations/`: ma'lumotlar bazasi sxemasi (SQL)
- `src/services/ops.ts`: savdo, qaytarish, nasiya, xarajat, mahsulot va ombor amallari (idempotent, tranzaksiyada)
- `src/services/reports.ts`: foyda, tushum va hisobotlar
- `src/routes/`: API yo'llari
- `test/`: avtomatik testlar
