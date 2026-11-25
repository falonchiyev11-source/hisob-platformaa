import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');
// .env avval server papkasidan, keyin yuqori papkadan o'qiladi (birinchi topilgan qiymat ustun)
loadEnv({ path: [path.join(SERVER_DIR, '.env'), path.join(ROOT_DIR, '.env')], quiet: true });

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? '',
  localDb: process.env.LOCAL_DB === 'true',
  localDbPort: Number(process.env.LOCAL_DB_PORT ?? 54330),
  localDbPassword: process.env.LOCAL_DB_PASSWORD ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Tashkent',
  tokenDays: Number(process.env.TOKEN_DAYS ?? 30),
  webDist: process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : path.join(ROOT_DIR, 'web', 'dist'),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data'),
  // Frontend boshqa manzilda joylashsa, uning manzili (masalan https://hisob.example.uz). Bir nechta bo'lsa vergul bilan.
  // Mayda farqlar hisobga olinmaydi: oxiridagi "/", yo'l (/login), qo'shtirnoq, katta-kichik harf.
  corsOrigins: (process.env.CORS_ORIGIN ?? '').split(/[,\s]+/).map(normalizeOrigin).filter(Boolean),
};

/** "https://Sayt.vercel.app/" yoki "'https://sayt.vercel.app/login'" → "https://sayt.vercel.app" */
export function normalizeOrigin(value: string | undefined | null): string {
  const s = (value ?? '').trim().replace(/^['"]+|['"]+$/g, '');
  if (!s) return '';
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).origin.toLowerCase();
  } catch {
    return s.replace(/\/+$/, '').toLowerCase();
  }
}

export function assertConfig() {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET .env faylida kamida 32 belgidan iborat bo‘lishi kerak. "npm run setup" ni ishga tushiring.');
  }
  if (!config.localDb && !config.databaseUrl) {
    throw new Error('DATABASE_URL ko‘rsatilmagan (yoki LOCAL_DB=true qiling).');
  }
}
