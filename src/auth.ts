import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { q } from './db.ts';
import { AppError } from './util.ts';

export interface AuthUser { id: string; role: 'admin' | 'seller'; fullName: string; username: string; script: 'latn' | 'cyrl' }

declare module 'fastify' {
  interface FastifyRequest { user2: AuthUser }
}
declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { sub: string }; user: { sub: string } }
}

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

/** Tokenni tekshiradi va foydalanuvchi hali faol ekanini bazadan tasdiqlaydi. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    throw new AppError(401, 'Tizimga qaytadan kiring', 'unauthorized');
  }
  const r = await q('SELECT id, role, full_name, username, script, active FROM users WHERE id=$1', [req.user.sub]);
  const u = r.rows[0];
  if (!u || !u.active) throw new AppError(401, 'Foydalanuvchi faol emas', 'unauthorized');
  req.user2 = { id: u.id, role: u.role, fullName: u.full_name, username: u.username, script: u.script };
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (req.user2.role !== 'admin') throw new AppError(403, 'Bu amal faqat administrator uchun', 'forbidden');
}

export function assertAdmin(u: AuthUser) {
  if (u.role !== 'admin') throw new AppError(403, 'Bu amal faqat administrator uchun', 'forbidden');
}
