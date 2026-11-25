/** Ma'lumotlarni o'qish uchun API (ro'yxatlar, tafsilotlar). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx } from '../db.ts';
import { requireAdmin, requireAuth } from '../auth.ts';
import { audit, bad, D, fmt, parse, todayStr, zDate, zText } from '../util.ts';
import { config } from '../config.ts';

const TZ = () => config.timezone;
const range = z.object({ from: zDate.optional(), to: zDate.optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() });

export const productColumns = `p.id, p.name, p.category_id AS "categoryId", c.name AS "categoryName", p.code,
  p.cost_price AS "costPrice", p.price, p.discount_price AS "discountPrice", p.premium_price AS "premiumPrice",
  trim_scale(p.stock)::text AS stock, p.unit, p.alt_unit AS "altUnit", trim_scale(p.alt_factor)::text AS "altFactor", p.alt_price AS "altPrice", p.note,
  (p.image IS NOT NULL) AS "hasImage", p.image_version AS "imageVersion", p.version, p.archived, p.updated_at AS "updatedAt"`;

export async function saleDetails(id: string) {
  const s = await q(
    `SELECT s.id, s.number, s.subtotal, s.total, s.cost_total AS "costTotal", s.note, s.created_at AS "createdAt",
            u.full_name AS "sellerName", cu.name AS "customerName", cu.phone AS "customerPhone"
       FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers cu ON cu.id = s.customer_id WHERE s.id = $1`, [id]);
  if (!s.rowCount) return null;
  const [items, pays, rets, debt] = await Promise.all([
    q(`SELECT si.id, si.product_id AS "productId", si.product_name AS "productName", trim_scale(si.qty)::text AS qty, si.unit_name AS "unitName", trim_scale(si.unit_factor)::text AS "unitFactor", si.base_price AS "basePrice",
              si.unit_price AS "unitPrice", si.cost_price AS "costPrice",
              trim_scale(coalesce((SELECT sum(qty) FROM return_items WHERE sale_item_id = si.id),0))::text AS "returnedQty"
         FROM sale_items si WHERE si.sale_id = $1 ORDER BY si.line_no`, [id]),
    q('SELECT method, amount FROM sale_payments WHERE sale_id=$1', [id]),
    q(`SELECT r.id, r.reason, r.total, r.refund_cash AS "refundCash", r.refund_card AS "refundCard", r.refund_click AS "refundClick",
              r.debt_reduction AS "debtReduction", r.created_at AS "createdAt", u.full_name AS "userName"
         FROM returns r JOIN users u ON u.id = r.user_id WHERE r.sale_id=$1 ORDER BY r.created_at`, [id]),
    q('SELECT id FROM debts WHERE sale_id=$1', [id]),
  ]);
  return { ...s.rows[0], number: Number(s.rows[0].number), items: items.rows, payments: pays.rows, returns: rets.rows, debtId: debt.rows[0]?.id ?? null };
}

const debtSelect = `
  SELECT d.id, d.sale_id AS "saleId", s.number AS "saleNumber", d.amount, d.note, d.created_at AS "createdAt",
         cu.id AS "customerId", cu.name AS "customerName", cu.phone AS "customerPhone",
         coalesce((SELECT sum(amount) FROM debt_payments WHERE debt_id = d.id),0) AS paid,
         coalesce((SELECT sum(debt_reduction) FROM returns WHERE sale_id = d.sale_id),0) AS reduced,
         (SELECT string_agg(si.product_name || ' × ' || trim_scale(si.qty) || ' ' || si.unit_name, ', ' ORDER BY si.line_no) FROM sale_items si WHERE si.sale_id = d.sale_id) AS products
    FROM debts d JOIN sales s ON s.id = d.sale_id JOIN customers cu ON cu.id = d.customer_id`;
const mapDebt = (d: any) => {
  const remaining = D(d.amount).minus(d.paid).minus(d.reduced);
  return { ...d, saleNumber: Number(d.saleNumber), paid: fmt(D(d.paid)), reduced: fmt(D(d.reduced)), remaining: fmt(remaining) };
};

export async function dataRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ---- Kategoriyalar ----
  app.get('/api/categories', async () => (await q('SELECT id, name FROM categories ORDER BY name')).rows);
  app.post('/api/categories', async (req) => {
    const p = parse(z.object({ name: zText(100).min(1, 'Nomini kiriting') }), req.body);
    return tx(async (c) => {
      const ex = await c.query('SELECT 1 FROM categories WHERE lower(name)=lower($1)', [p.name]);
      if (ex.rowCount) throw bad('Bunday kategoriya bor');
      const r = await c.query('INSERT INTO categories(name) VALUES ($1) RETURNING id, name', [p.name]);
      await audit(c, req.user2.id, 'category.create', 'category', r.rows[0].id, p);
      return r.rows[0];
    });
  });
  app.put('/api/categories/:id', async (req) => {
    const p = parse(z.object({ name: zText(100).min(1) }), req.body);
    const { id } = req.params as { id: string };
    return tx(async (c) => {
      const r = await c.query('UPDATE categories SET name=$2 WHERE id=$1 RETURNING id, name', [id, p.name]);
      if (!r.rowCount) throw bad('Kategoriya topilmadi');
      await audit(c, req.user2.id, 'category.update', 'category', id, p);
      return r.rows[0];
    });
  });
  app.delete('/api/categories/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    return tx(async (c) => {
      const used = await c.query('SELECT count(*)::int n FROM products WHERE category_id=$1 AND NOT archived', [id]);
      if (used.rows[0].n > 0) throw bad(`Bu kategoriyada ${used.rows[0].n} ta mahsulot bor. Avval ularni boshqa kategoriyaga o‘tkazing.`);
      await c.query('UPDATE products SET category_id = NULL WHERE category_id=$1', [id]);
      await c.query('DELETE FROM categories WHERE id=$1', [id]);
      await audit(c, req.user2.id, 'category.delete', 'category', id);
      return { ok: true };
    });
  });

  // ---- Mahsulotlar ----
  app.get('/api/products', async (req) => {
    const p = parse(z.object({ q: z.string().optional(), archived: z.enum(['0', '1']).optional() }), req.query);
    const r = await q(`SELECT ${productColumns} FROM products p LEFT JOIN categories c ON c.id = p.category_id
                        WHERE p.archived = $1 AND ($2::text IS NULL OR lower(p.name) LIKE '%'||lower($2)||'%' OR lower(p.code) = lower($2))
                        ORDER BY p.name`, [p.archived === '1', p.q?.trim() || null]);
    return r.rows;
  });
  app.get('/api/products/:id/image', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await q('SELECT image FROM products WHERE id=$1', [id]);
    const img: string | null = r.rows[0]?.image ?? null;
    if (!img) return reply.code(404).send({ error: 'Rasm yo‘q' });
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(img)!;
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type(m[1]).send(Buffer.from(m[2], 'base64'));
  });

  // ---- Ombor harakatlari tarixi ----
  app.get('/api/inventory/movements', async (req) => {
    const p = parse(range.extend({ productId: z.string().uuid().optional(), type: z.string().optional() }), req.query);
    const r = await q(
      `SELECT m.id, m.product_id AS "productId", p.name AS "productName", p.unit, trim_scale(m.delta)::text AS delta, m.type, m.ref_id AS "refId", m.note,
              m.created_at AS "createdAt", u.full_name AS "userName",
              (SELECT number FROM sales WHERE id = m.ref_id) AS "saleNumber"
         FROM inventory_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
        WHERE ($1::uuid IS NULL OR m.product_id = $1) AND ($2::date IS NULL OR (m.created_at AT TIME ZONE $5)::date >= $2)
          AND ($3::date IS NULL OR (m.created_at AT TIME ZONE $5)::date <= $3) AND ($6::text IS NULL OR m.type = $6)
        ORDER BY m.created_at DESC LIMIT $4`,
      [p.productId ?? null, p.from ?? null, p.to ?? null, p.limit ?? 300, TZ(), p.type || null],
    );
    return r.rows.map((x) => ({ ...x, saleNumber: x.saleNumber ? Number(x.saleNumber) : null }));
  });

  // ---- Savdolar ----
  app.get('/api/sales', async (req) => {
    const p = parse(range, req.query);
    const num = p.q && /^\d+$/.test(p.q.trim()) ? Number(p.q.trim()) : null;
    const r = await q(
      `SELECT s.id, s.number, s.total, s.created_at AS "createdAt", u.full_name AS "sellerName", cu.name AS "customerName",
              (SELECT json_object_agg(method, amount) FROM sale_payments WHERE sale_id = s.id) AS payments,
              (SELECT count(*) FROM sale_items WHERE sale_id = s.id)::int AS "itemCount",
              coalesce((SELECT sum(total) FROM returns WHERE sale_id = s.id),0) AS "returnedTotal"
         FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers cu ON cu.id = s.customer_id
        WHERE ($1::date IS NULL OR (s.created_at AT TIME ZONE $4)::date >= $1) AND ($2::date IS NULL OR (s.created_at AT TIME ZONE $4)::date <= $2)
          AND ($5::bigint IS NULL OR s.number = $5)
        ORDER BY s.created_at DESC LIMIT $3`,
      [p.from ?? null, p.to ?? null, p.limit ?? 200, TZ(), num],
    );
    return r.rows.map((x) => ({ ...x, number: Number(x.number) }));
  });
  app.get('/api/sales/:id', async (req) => {
    const d = await saleDetails((req.params as any).id);
    if (!d) throw bad('Savdo topilmadi');
    return d;
  });
  app.get('/api/sales/by-number/:n', async (req) => {
    const r = await q('SELECT id FROM sales WHERE number=$1', [Number((req.params as any).n) || 0]);
    if (!r.rowCount) throw bad('Bu raqamli savdo topilmadi');
    return saleDetails(r.rows[0].id);
  });

  // ---- Qaytarishlar ----
  app.get('/api/returns', async (req) => {
    const p = parse(range, req.query);
    const r = await q(
      `SELECT r.id, r.sale_id AS "saleId", s.number AS "saleNumber", r.reason, r.total, r.refund_cash AS "refundCash", r.refund_card AS "refundCard",
              r.refund_click AS "refundClick", r.debt_reduction AS "debtReduction", r.created_at AS "createdAt", u.full_name AS "userName",
              (SELECT string_agg(si.product_name || ' × ' || trim_scale(ri.qty) || ' ' || si.unit_name, ', ') FROM return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = r.id) AS products,
              ((SELECT sum(qty) FROM return_items WHERE return_id = r.id) >= (SELECT sum(qty) FROM sale_items WHERE sale_id = r.sale_id)) AS "isFull"
         FROM returns r JOIN sales s ON s.id = r.sale_id JOIN users u ON u.id = r.user_id
        WHERE ($1::date IS NULL OR (r.created_at AT TIME ZONE $4)::date >= $1) AND ($2::date IS NULL OR (r.created_at AT TIME ZONE $4)::date <= $2)
        ORDER BY r.created_at DESC LIMIT $3`,
      [p.from ?? null, p.to ?? null, p.limit ?? 200, TZ()],
    );
    return r.rows.map((x) => ({ ...x, saleNumber: Number(x.saleNumber) }));
  });

  // ---- Nasiya ----
  app.get('/api/debts', async (req) => {
    const p = parse(z.object({ status: z.enum(['open', 'closed', 'all']).default('open'), q: z.string().optional() }), req.query);
    const r = await q(`${debtSelect} WHERE ($1::text IS NULL OR lower(cu.name) LIKE '%'||lower($1)||'%' OR cu.phone LIKE '%'||$1||'%') ORDER BY d.created_at DESC`, [p.q?.trim() || null]);
    const rows = r.rows.map(mapDebt);
    return rows.filter((d) => p.status === 'all' || (p.status === 'open' ? D(d.remaining).gt(0) : D(d.remaining).lte(0)));
  });
  app.get('/api/debts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const r = await q(`${debtSelect} WHERE d.id = $1`, [id]);
    if (!r.rowCount) throw bad('Nasiya topilmadi');
    const pays = await q(`SELECT dp.id, dp.amount, dp.method, dp.note, dp.created_at AS "createdAt", u.full_name AS "userName"
                            FROM debt_payments dp JOIN users u ON u.id = dp.user_id WHERE dp.debt_id=$1 ORDER BY dp.created_at`, [id]);
    return { ...mapDebt(r.rows[0]), payments: pays.rows, sale: await saleDetails(r.rows[0].saleId) };
  });
  app.get('/api/customers', async (req) => {
    const p = parse(z.object({ q: z.string().optional() }), req.query);
    const r = await q(`SELECT id, name, phone FROM customers WHERE ($1::text IS NULL OR lower(name) LIKE '%'||lower($1)||'%' OR phone LIKE '%'||$1||'%') ORDER BY name LIMIT 50`, [p.q?.trim() || null]);
    return r.rows;
  });

  // ---- Xarajatlar ----
  app.get('/api/expenses', async (req) => {
    const p = parse(range.extend({ kind: z.enum(['all', 'regular', 'recurring']).default('all') }), req.query);
    const r = await q(
      `SELECT e.id, e.name, e.amount, e.category, e.expense_date AS "expenseDate", e.note, e.paid_from_cash AS "paidFromCash",
              e.recurring_id AS "recurringId", e.created_at AS "createdAt", u.full_name AS "userName"
         FROM expenses e JOIN users u ON u.id = e.user_id
        WHERE e.deleted_at IS NULL AND ($1::date IS NULL OR e.expense_date >= $1) AND ($2::date IS NULL OR e.expense_date <= $2)
          AND ($4 = 'all' OR ($4 = 'recurring') = (e.recurring_id IS NOT NULL))
        ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $3`,
      [p.from ?? null, p.to ?? null, p.limit ?? 300, p.kind],
    );
    return r.rows.map((x) => ({ ...x, expenseDate: dateStr(x.expenseDate) }));
  });

  // ---- Amallar tarixi (audit) ----
  app.get('/api/audit', { preHandler: requireAdmin }, async (req) => {
    const p = parse(range, req.query);
    const r = await q(
      `SELECT a.id, a.action, a.entity, a.entity_id AS "entityId", a.details, a.created_at AS "createdAt", u.full_name AS "userName"
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        WHERE ($1::date IS NULL OR (a.created_at AT TIME ZONE $4)::date >= $1) AND ($2::date IS NULL OR (a.created_at AT TIME ZONE $4)::date <= $2)
        ORDER BY a.created_at DESC LIMIT $3`,
      [p.from ?? null, p.to ?? null, p.limit ?? 300, TZ()],
    );
    return r.rows;
  });

  app.get('/api/today', async () => ({ today: todayStr(), timezone: TZ() }));
}

export const dateStr = (d: unknown) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d));
