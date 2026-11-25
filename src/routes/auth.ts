import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx } from '../db.ts';
import { checkPassword, hashPassword, requireAdmin, requireAuth } from '../auth.ts';
import { AppError, audit, bad, parse, zText } from '../util.ts';
import { config } from '../config.ts';

// Kirish nomi — do'kon nomi (yoki sotuvchi uchun berilgan nom). Bo'sh joy, kirill, apostrof bo'lishi mumkin.
// Katta-kichik harf farq qilmaydi; ortiqcha bo'sh joylar bittaga qisqartiriladi.
const zUsername = z.string().transform((v) => v.trim().replace(/\s+/g, ' '))
  .refine((v) => v.length >= 2 && v.length <= 60, 'Nom 2–60 belgidan iborat bo‘lsin');
const normName = (v: string) => v.trim().replace(/\s+/g, ' ');
/** Qidiruv kaliti: kichik harflar (har qanday alifboda), apostrof turlari bir xil. "Ali Do‘koni" → "ali do'koni" */
export const loginKey = (v: string) => normName(v).normalize('NFC').toLowerCase().replace(/[‘’ʻʼ`´]/g, "'");
const zPassword = z.string().min(6, 'Parol kamida 6 belgi bo‘lsin').max(100);

export async function authRoutes(app: FastifyInstance) {
  const sign = (id: string) => app.jwt.sign({ sub: id }, { expiresIn: `${config.tokenDays}d` });
  const publicUser = (u: any) => ({ id: u.id, username: u.username, fullName: u.full_name, role: u.role, script: u.script, active: u.active });

  app.get('/api/setup/status', async () => {
    const r = await q('SELECT count(*)::int n FROM users');
    return { needsSetup: r.rows[0].n === 0 };
  });

  // Birinchi ishga tushirishda do'kon nomi va parol bilan administrator yaratiladi (oldindan berilgan parol yo'q).
  app.post('/api/setup', async (req) => {
    const body = parse(z.object({ username: zUsername, fullName: zText(100).optional(), password: zPassword }), req.body);
    const p = { ...body, fullName: body.fullName || body.username };
    const user = await tx(async (c) => {
      await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const n = await c.query('SELECT count(*)::int n FROM users');
      if (n.rows[0].n > 0) throw new AppError(409, 'Tizim allaqachon sozlangan');
      const r = await c.query("INSERT INTO users(username, login_key, full_name, password_hash, role) VALUES ($1,$2,$3,$4,'admin') RETURNING *", [p.username, loginKey(p.username), p.fullName, await hashPassword(p.password)]);
      await audit(c, r.rows[0].id, 'setup.admin', 'user', r.rows[0].id);
      return r.rows[0];
    });
    return { token: sign(user.id), user: publicUser(user) };
  });

  app.post('/api/auth/login', async (req) => {
    const p = parse(z.object({ username: z.string().transform(normName), password: z.string() }), req.body);
    const r = await q('SELECT * FROM users WHERE login_key=$1', [loginKey(p.username)]);
    const u = r.rows[0];
    if (!u || !(await checkPassword(p.password, u.password_hash))) throw new AppError(401, 'Do‘kon nomi yoki parol noto‘g‘ri');
    if (!u.active) throw new AppError(403, 'Foydalanuvchi bloklangan');
    await q("INSERT INTO audit_logs(user_id, action, entity, entity_id) VALUES ($1,'auth.login','user',$2)", [u.id, u.id]);
    return { token: sign(u.id), user: publicUser(u) };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const u = req.user2;
    return { user: { id: u.id, username: u.username, fullName: u.fullName, role: u.role, script: u.script, active: true } };
  });

  app.put('/api/auth/script', { preHandler: requireAuth }, async (req) => {
    const p = parse(z.object({ script: z.enum(['latn', 'cyrl']) }), req.body);
    await q('UPDATE users SET script=$2 WHERE id=$1', [req.user2.id, p.script]);
    return { ok: true };
  });

  app.post('/api/auth/password', { preHandler: requireAuth }, async (req) => {
    const p = parse(z.object({ oldPassword: z.string(), newPassword: zPassword }), req.body);
    const r = await q('SELECT password_hash FROM users WHERE id=$1', [req.user2.id]);
    if (!(await checkPassword(p.oldPassword, r.rows[0].password_hash))) throw bad('Eski parol noto‘g‘ri');
    await tx(async (c) => {
      await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user2.id, await hashPassword(p.newPassword)]);
      await audit(c, req.user2.id, 'user.password', 'user', req.user2.id);
    });
    return { ok: true };
  });

  // --- Foydalanuvchilarni boshqarish (faqat administrator) ---
  app.get('/api/users', { preHandler: requireAdmin }, async () => {
    const r = await q('SELECT * FROM users ORDER BY created_at');
    return r.rows.map(publicUser);
  });

  app.post('/api/users', { preHandler: requireAdmin }, async (req) => {
    const p = parse(z.object({ username: zUsername, fullName: zText(100).min(1), password: zPassword, role: z.enum(['admin', 'seller']) }), req.body);
    return tx(async (c) => {
      const ex = await c.query('SELECT 1 FROM users WHERE login_key=$1', [loginKey(p.username)]);
      if (ex.rowCount) throw bad('Bu nom band');
      const r = await c.query('INSERT INTO users(username, login_key, full_name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING *', [p.username, loginKey(p.username), p.fullName, await hashPassword(p.password), p.role]);
      await audit(c, req.user2.id, 'user.create', 'user', r.rows[0].id, { username: p.username, role: p.role });
      return publicUser(r.rows[0]);
    });
  });

  app.put('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const p = parse(z.object({ fullName: zText(100).min(1).optional(), role: z.enum(['admin', 'seller']).optional(), active: z.boolean().optional(), password: zPassword.optional() }), req.body);
    return tx(async (c) => {
      const cur = await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]);
      if (!cur.rowCount) throw bad('Foydalanuvchi topilmadi');
      if ((p.role === 'seller' || p.active === false) && cur.rows[0].role === 'admin') {
        const admins = await c.query("SELECT count(*)::int n FROM users WHERE role='admin' AND active AND id<>$1", [id]);
        if (admins.rows[0].n === 0) throw bad('Kamida bitta faol administrator qolishi kerak');
      }
      const r = await c.query(
        `UPDATE users SET full_name = coalesce($2, full_name), role = coalesce($3, role), active = coalesce($4, active),
                password_hash = coalesce($5, password_hash) WHERE id=$1 RETURNING *`,
        [id, p.fullName ?? null, p.role ?? null, p.active ?? null, p.password ? await hashPassword(p.password) : null],
      );
      await audit(c, req.user2.id, 'user.update', 'user', id, { fullName: p.fullName, role: p.role, active: p.active, passwordReset: !!p.password });
      return publicUser(r.rows[0]);
    });
  });
}
