/** Dashboard, hisobotlar, doimiy xarajatlar, kunni yakunlash va o'zgartiruvchi amallar. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx } from '../db.ts';
import { assertAdmin, requireAuth } from '../auth.ts';
import { AppError, D, audit, bad, fmt, parse, todayStr, zDate, zMoney, zOptText, zPositiveMoney, zText, zUuid } from '../util.ts';
import { expectedCash, suggestedOpening, summary } from '../services/reports.ts';
import { dueDates } from '../services/recurring.ts';
import { runOp } from '../services/ops.ts';


export async function financeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ---------- DASHBOARD ----------
  app.get('/api/dashboard', async () => {
    const today = todayStr();
    const [s, stock, lastSales, lastExpenses, pending, debtsOpen] = await Promise.all([
      summary(today, today),
      q(`SELECT count(*) FILTER (WHERE stock > 0)::int AS "inStock", count(*) FILTER (WHERE stock <= 0)::int AS "outOfStock",
                coalesce(sum(stock) FILTER (WHERE stock > 0 AND unit = 'dona'),0)::bigint AS units, count(*)::int AS total
           FROM products WHERE NOT archived`),
      q(`SELECT s.id, s.number, s.total, s.created_at AS "createdAt", u.full_name AS "sellerName",
                (SELECT json_object_agg(method, amount) FROM sale_payments WHERE sale_id = s.id) AS payments
           FROM sales s JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC LIMIT 8`),
      q(`SELECT e.id, e.name, e.amount, e.expense_date AS "expenseDate", e.note, e.created_at AS "createdAt", u.full_name AS "userName"
           FROM expenses e JOIN users u ON u.id = e.user_id WHERE e.deleted_at IS NULL ORDER BY e.created_at DESC LIMIT 8`),
      pendingRecurring(),
      q(`SELECT coalesce(sum(d.amount - coalesce((SELECT sum(amount) FROM debt_payments WHERE debt_id=d.id),0)
                                  - coalesce((SELECT sum(debt_reduction) FROM returns WHERE sale_id=d.sale_id),0)),0) AS total FROM debts d`),
    ]);
    return {
      today, summary: s,
      stock: { ...stock.rows[0], units: Number(stock.rows[0].units) },
      lastSales: lastSales.rows.map((x) => ({ ...x, number: Number(x.number) })),
      lastExpenses: lastExpenses.rows,
      pendingRecurring: pending.length,
      openDebtTotal: fmt(D(debtsOpen.rows[0].total)),
    };
  });

  // ---------- HISOBOTLAR ----------
  app.get('/api/reports/summary', async (req) => {
    const p = parse(z.object({ from: zDate, to: zDate }), req.query);
    if (p.from > p.to) throw bad('Boshlanish sanasi tugash sanasidan keyin bo‘lmasin');
    return summary(p.from, p.to);
  });
  app.get('/api/reports/daily', async (req) => {
    const p = parse(z.object({ from: zDate, to: zDate }), req.query);
    // Har bir kun bo'yicha qisqa jadval (oylik hisobotdagi kunlar ro'yxati uchun)
    const days: string[] = [];
    for (let d = new Date(p.from + 'T00:00:00Z'); d <= new Date(p.to + 'T00:00:00Z'); d = new Date(d.getTime() + 86400_000)) days.push(d.toISOString().slice(0, 10));
    if (days.length > 62) throw bad('Oraliq 62 kundan oshmasin');
    const rows = [];
    for (const day of days) {
      const s = await summary(day, day);
      rows.push({ date: day, netSales: s.netSales, productProfit: s.productProfit, expenses: s.expenses.total, netProfit: s.netProfit, salesCount: s.salesCount });
    }
    return rows;
  });

  // ---------- DOIMIY XARAJATLAR ----------
  const recSchema = z.object({
    name: zText(200).min(1, 'Nomini kiriting'), amount: zPositiveMoney, period: z.enum(['daily', 'weekly', 'monthly']),
    startDate: zDate, category: zOptText(100), note: zOptText(1000), paidFromCash: z.boolean().default(true), active: z.boolean().default(true),
  });
  app.get('/api/recurring', async () => {
    const r = await q(`SELECT r.id, r.name, r.amount, r.period, r.start_date AS "startDate", r.category, r.note, r.paid_from_cash AS "paidFromCash",
                              r.active, r.created_at AS "createdAt", u.full_name AS "createdByName",
                              (SELECT max(period_key) FROM recurring_confirmations WHERE recurring_id = r.id AND status='confirmed') AS "lastConfirmed"
                         FROM recurring_expenses r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.active DESC, r.name`);
    return r.rows;
  });
  app.post('/api/recurring', async (req) => {
    const p = parse(recSchema, req.body);
    return tx(async (c) => {
      const r = await c.query(
        `INSERT INTO recurring_expenses(name, amount, period, start_date, category, note, paid_from_cash, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [p.name, p.amount, p.period, p.startDate, p.category, p.note, p.paidFromCash, p.active, req.user2.id],
      );
      await audit(c, req.user2.id, 'recurring.create', 'recurring_expense', r.rows[0].id, p);
      return { id: r.rows[0].id };
    });
  });
  app.put('/api/recurring/:id', async (req) => {
    const { id } = req.params as { id: string };
    const p = parse(recSchema, req.body);
    return tx(async (c) => {
      const cur = await c.query('SELECT start_date, period FROM recurring_expenses WHERE id=$1 FOR UPDATE', [id]);
      if (!cur.rowCount) throw bad('Topilmadi');
      const used = await c.query('SELECT count(*)::int n FROM recurring_confirmations WHERE recurring_id=$1', [id]);
      if (used.rows[0].n > 0 && (cur.rows[0].start_date !== p.startDate || cur.rows[0].period !== p.period)) {
        throw bad('Tasdiqlangan davrlari bor xarajatning davri va boshlanish sanasini o‘zgartirib bo‘lmaydi. Uni faolsizlantirib, yangisini yarating.');
      }
      await c.query(
        `UPDATE recurring_expenses SET name=$2, amount=$3, period=$4, start_date=$5, category=$6, note=$7, paid_from_cash=$8, active=$9, updated_at=now() WHERE id=$1`,
        [id, p.name, p.amount, p.period, p.startDate, p.category, p.note, p.paidFromCash, p.active],
      );
      await audit(c, req.user2.id, 'recurring.update', 'recurring_expense', id, p);
      return { id };
    });
  });
  app.get('/api/recurring/pending', async () => pendingRecurring());

  // ---------- KUNNI YAKUNLASH ----------
  app.get('/api/closings', async () => {
    const r = await q(`SELECT dc.close_date AS date, dc.opening_cash AS "openingCash", dc.expected_cash AS "expectedCash", dc.actual_cash AS "actualCash",
                              dc.difference, dc.closed_at AS "closedAt", u.full_name AS "closedByName",
                              dc.summary->>'netSales' AS "netSales", dc.summary->>'netProfit' AS "netProfit"
                         FROM daily_closings dc JOIN users u ON u.id = dc.closed_by ORDER BY dc.close_date DESC LIMIT 366`);
    return r.rows;
  });
  app.get('/api/closings/preview', async (req) => {
    const p = parse(z.object({ date: zDate.optional() }), req.query);
    const date = p.date ?? todayStr();
    const existing = await q(`SELECT dc.*, u.full_name AS "closedByName" FROM daily_closings dc JOIN users u ON u.id = dc.closed_by WHERE close_date=$1`, [date]);
    const s = await summary(date, date);
    const opening = existing.rowCount ? fmt(D(existing.rows[0].opening_cash)) : await suggestedOpening(date);
    const pending = (await pendingRecurring()).filter((x) => x.periodKey <= date);
    return {
      date, summary: s, openingCash: opening, expectedCash: expectedCash(opening, s), pendingRecurring: pending.length,
      closing: existing.rowCount ? closingDto(existing.rows[0]) : null,
    };
  });
  app.get('/api/closings/:date', async (req) => {
    const { date } = parse(z.object({ date: zDate }), req.params);
    const r = await q(`SELECT dc.*, u.full_name AS "closedByName" FROM daily_closings dc JOIN users u ON u.id = dc.closed_by WHERE close_date=$1`, [date]);
    if (!r.rowCount) throw bad('Bu kun yopilmagan');
    return closingDto(r.rows[0]);
  });
  app.post('/api/closings', async (req) => {
    const p = parse(z.object({ date: zDate, openingCash: zMoney, actualCash: zMoney, note: zOptText(1000), overwrite: z.boolean().default(false) }), req.body);
    if (p.date > todayStr()) throw bad('Kelajakdagi kunni yopib bo‘lmaydi');
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(7771)');
      const ex = await c.query('SELECT id FROM daily_closings WHERE close_date=$1 FOR UPDATE', [p.date]);
      if (ex.rowCount && !p.overwrite) throw new AppError(409, 'Bu kun allaqachon yopilgan', 'closed');
      if (ex.rowCount) assertAdmin(req.user2);
      const s = await summary(p.date, p.date, c);
      const expected = expectedCash(p.openingCash, s);
      const diff = fmt(D(p.actualCash).minus(expected));
      const vals = [p.date, p.openingCash, expected, p.actualCash, diff, JSON.stringify(s), p.note, req.user2.id];
      if (ex.rowCount) {
        await c.query(`UPDATE daily_closings SET opening_cash=$2, expected_cash=$3, actual_cash=$4, difference=$5, summary=$6, note=$7, closed_by=$8, closed_at=now() WHERE close_date=$1`, vals);
      } else {
        await c.query(`INSERT INTO daily_closings(close_date, opening_cash, expected_cash, actual_cash, difference, summary, note, closed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, vals);
      }
      await audit(c, req.user2.id, ex.rowCount ? 'closing.reclose' : 'closing.close', 'closing', p.date, { expected, actual: p.actualCash, difference: diff });
      const r = await c.query(`SELECT dc.*, u.full_name AS "closedByName" FROM daily_closings dc JOIN users u ON u.id = dc.closed_by WHERE close_date=$1`, [p.date]);
      return closingDto(r.rows[0]);
    });
  });

  // ---------- O'ZGARTIRUVCHI AMALLAR ----------
  // Har bir amal brauzerda yaratilgan UUID bilan keladi: tugma ikki marta bosilsa yoki so'rov qayta yuborilsa ham, faqat bir marta bajariladi.
  const opSchema = z.object({ id: zUuid, type: z.string(), payload: z.unknown() });
  app.post('/api/ops', async (req) => {
    const op = parse(opSchema, req.body);
    return runOp(req.user2, op);
  });
}

function closingDto(r: any) {
  return {
    date: r.close_date, openingCash: r.opening_cash, expectedCash: r.expected_cash, actualCash: r.actual_cash, difference: r.difference,
    summary: r.summary, note: r.note, closedAt: r.closed_at, closedByName: r.closedByName,
  };
}

/** Muddati kelgan, lekin hali tasdiqlanmagan (va o'tkazib yuborilmagan) doimiy xarajat davrlari. */
export async function pendingRecurring() {
  const today = todayStr();
  const recs = await q('SELECT * FROM recurring_expenses WHERE active ORDER BY name');
  const done = await q('SELECT recurring_id, period_key FROM recurring_confirmations');
  const doneSet = new Set(done.rows.map((d) => `${d.recurring_id}|${d.period_key}`));
  const out: any[] = [];
  for (const r of recs.rows) {
    for (const key of dueDates(r.period, r.start_date, today, 90)) {
      if (!doneSet.has(`${r.id}|${key}`)) {
        out.push({ recurringId: r.id, name: r.name, amount: r.amount, period: r.period, periodKey: key, paidFromCash: r.paid_from_cash, category: r.category, note: r.note });
      }
    }
  }
  return out.sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));
}
