// server/.env faylini .env.example asosida yaratadi va maxfiy kalitlarni tasodifiy qiymatlar bilan to'ldiradi.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(dir, '.env');
if (fs.existsSync(envPath)) {
  console.log('.env allaqachon mavjud — o‘zgartirilmadi.');
} else {
  let text = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
  text = text.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`);
  text = text.replace(/^LOCAL_DB_PASSWORD=.*$/m, `LOCAL_DB_PASSWORD=${crypto.randomBytes(18).toString('hex')}`);
  fs.writeFileSync(envPath, text);
  console.log('.env yaratildi.');
}
