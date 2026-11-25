/**
 * Hisobotlar va foyda hisobi. Barcha raqamlar bazadagi haqiqiy yozuvlardan, NUMERIC + decimal.js bilan hisoblanadi.
 *
 *  Mahsulot foydasi  = Σ (sotilgan narx − tannarx) × soni  −  qaytarilganlar bo'yicha shu foyda
 *  Sof foyda         = Mahsulot foydasi − oddiy xarajatlar − tasdiqlangan doimiy xarajatlar
 *  Tushum (naqd/karta/Click) = savdo to'lovi + nasiya qarzi to'lovi − qaytarilgan pul
 *  Nasiya savdo hech qachon tushumga qo'shilmaydi — u qarz to'langan kuni tushum bo'ladi.
 */
import { q, type Client } from '../db.ts';
import { config } from '../config.ts';
import { D, fmt } from '../util.ts';

type Runner = { query: Client['query'] } | null;
// Tranzaksiya ichida (bitta ulanish) so'rovlar navbat bilan bajariladi; aks holda pool orqali parallel.
const chains = new WeakMap<object, Promise<unknown>>();
const run = (r: Runner, text: string, params: unknown[]): Promise<any> => {
  if (!r) return q(text, params);
  const next = (chains.get(r) ?? Promise.resolve()).then(() => r.query(text, params));
  chains.set(r, next.catch(() => {}));
  return next;
};

const inRange = (col: string) => `(${col} AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`;

export async function summary(from: string, to: string, runner: Runner = null) {
  const P = [from, to, config.timezone];
  const [sales, pays, debtPays, rets, exps, cashExp, products] = await Promise.all([
    run(runner, `SELECT count(*)::int AS n, coalesce(sum(total),0) total, coalesce(sum(subtotal),0) subtotal, coalesce(sum(cost_total),0) cost
                   FROM sales WHERE ${inRange('created_at')}`, P),
    run(runner, `SELECT sp.method, coalesce(sum(sp.amount),0) amount FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
                   WHERE ${inRange('s.created_at')} GROUP BY sp.method`, P),
    run(runner, `SELECT method, coalesce(sum(amount),0) amount FROM debt_payments WHERE ${inRange('created_at')} GROUP BY method`, P),
    run(runner, `SELECT count(*)::int AS n, coalesce(sum(total),0) total, coalesce(sum(base_total),0) base, coalesce(sum(cost_total),0) cost,
                        coalesce(sum(refund_cash),0) cash, coalesce(sum(refund_card),0) card, coalesce(sum(refund_click),0) click,
                        coalesce(sum(debt_reduction),0) debt
                   FROM returns WHERE ${inRange('created_at')}`, P),
    run(runner, `SELECT (recurring_id IS NOT NULL) AS recurring, coalesce(sum(amount),0) amount, count(*)::int n
                   FROM expenses WHERE deleted_at IS NULL AND expense_date BETWEEN $1::date AND $2::date AND $3::text IS NOT NULL
                   GROUP BY 1`, P),
    run(runner, `SELECT coalesce(sum(amount),0) amount FROM expenses
                   WHERE deleted_at IS NULL AND paid_from_cash AND ${inRange('created_at')}`, P),
    // qty — sotilgan birlikda (masalan qop), factor — shu birlikdagi asosiy birlik soni (50 kg).
    // Miqdorlar asosiy birlikda jamlanadi; foyda = qty × sotilgan narx − qty × factor × tannarx.
    run(runner, `WITH sold AS (
                     SELECT si.product_id, si.qty, si.unit_factor AS factor, si.unit_price, si.base_price, si.cost_price
                       FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE ${inRange('s.created_at')}),
                   ret AS (
                     SELECT ri.product_id, ri.qty, si.unit_factor AS factor, ri.unit_price, ri.base_price, ri.cost_price
                       FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN sale_items si ON si.id = ri.sale_item_id
                      WHERE ${inRange('r.created_at')})
                 SELECT p.id, p.name, p.unit,
                        coalesce((SELECT sum(qty*factor) FROM sold WHERE product_id = p.id),0) AS sold_qty,
                        coalesce((SELECT sum(qty*factor) FROM ret WHERE product_id = p.id),0) AS returned_qty,
                        coalesce((SELECT sum(qty*unit_price) FROM sold WHERE product_id = p.id),0)
                          - coalesce((SELECT sum(qty*unit_price) FROM ret WHERE product_id = p.id),0) AS revenue,
                        coalesce((SELECT sum(qty*(base_price-unit_price)) FROM sold WHERE product_id = p.id),0)
                          - coalesce((SELECT sum(qty*(base_price-unit_price)) FROM ret WHERE product_id = p.id),0) AS discount,
                        coalesce((SELECT sum(qty*unit_price - qty*factor*cost_price) FROM sold WHERE product_id = p.id),0)
                          - coalesce((SELECT sum(qty*unit_price - qty*factor*cost_price) FROM ret WHERE product_id = p.id),0) AS profit
                   FROM products p
                  WHERE p.id IN (SELECT product_id FROM sold UNION SELECT product_id FROM ret)
                  ORDER BY revenue DESC, p.name`, P),
  ]);

  const s = sales.rows[0], r = rets.rows[0];
  const pay = Object.fromEntries(pays.rows.map((x: any) => [x.method, D(x.amount)]));
  const dp = Object.fromEntries(debtPays.rows.map((x: any) => [x.method, D(x.amount)]));
  const exp = { regular: D(0), recurring: D(0), regularCount: 0, recurringCount: 0 };
  for (const x of exps.rows as any[]) {
    if (x.recurring) { exp.recurring = D(x.amount); exp.recurringCount = x.n; } else { exp.regular = D(x.amount); exp.regularCount = x.n; }
  }

  const grossSales = D(s.total);
  const returnsTotal = D(r.total);
  const salesProfit = D(s.total).minus(s.cost);
  const returnsProfit = D(r.total).minus(r.cost);
  const productProfit = salesProfit.minus(returnsProfit);
  const discounts = D(s.subtotal).minus(s.total).minus(D(r.base).minus(r.total));
  const income = (m: 'cash' | 'card' | 'click') => (pay[m] ?? D(0)).plus(dp[m] ?? D(0)).minus(r[m]);
  const cashIn = income('cash'), cardIn = income('card'), clickIn = income('click');
  const expensesTotal = exp.regular.plus(exp.recurring);
  const netProfit = productProfit.minus(expensesTotal);
  const cashExpenses = D(cashExp.rows[0].amount);

  return {
    from, to,
    salesCount: s.n,
    grossSales: fmt(grossSales),
    returnsCount: r.n,
    returnsTotal: fmt(returnsTotal),
    netSales: fmt(grossSales.minus(returnsTotal)),
    discounts: fmt(discounts),
    salePayments: {
      cash: fmt(pay.cash ?? D(0)), card: fmt(pay.card ?? D(0)), click: fmt(pay.click ?? D(0)), debt: fmt(pay.debt ?? D(0)),
    },
    debtSales: fmt(pay.debt ?? D(0)),
    debtRepayments: { cash: fmt(dp.cash ?? D(0)), card: fmt(dp.card ?? D(0)), click: fmt(dp.click ?? D(0)) },
    refunds: { cash: fmt(D(r.cash)), card: fmt(D(r.card)), click: fmt(D(r.click)), debtReduction: fmt(D(r.debt)) },
    income: { cash: fmt(cashIn), card: fmt(cardIn), click: fmt(clickIn), total: fmt(cashIn.plus(cardIn).plus(clickIn)) },
    productProfit: fmt(productProfit),
    expenses: {
      regular: fmt(exp.regular), recurring: fmt(exp.recurring), total: fmt(expensesTotal),
      regularCount: exp.regularCount, recurringCount: exp.recurringCount,
    },
    cashExpenses: fmt(cashExpenses),
    netCashFlow: fmt(cashIn.minus(cashExpenses)),
    netProfit: fmt(netProfit),
    products: products.rows.map((x: any) => ({
      productId: x.id, name: x.name, unit: x.unit,
      soldQty: qtyStr(x.sold_qty), returnedQty: qtyStr(x.returned_qty), netQty: qtyStr(D(x.sold_qty).minus(x.returned_qty)),
      revenue: fmt(D(x.revenue)), discount: fmt(D(x.discount)), profit: fmt(D(x.profit)),
    })),
  };
}

export type Summary = Awaited<ReturnType<typeof summary>>;

/** Kun boshidagi kassa: oldingi yopilgan kundagi haqiqiy pul. */
export async function suggestedOpening(date: string, runner: Runner = null) {
  const r = await run(runner, 'SELECT actual_cash FROM daily_closings WHERE close_date < $1::date ORDER BY close_date DESC LIMIT 1', [date]);
  return r.rowCount ? fmt(D(r.rows[0].actual_cash)) : '0.00';
}

export function expectedCash(opening: string, s: Summary) {
  return fmt(D(opening).plus(s.netCashFlow));
}

/** Miqdor matni: ortiqcha nollarsiz ("2.500" → "2.5", "3.000" → "3"). */
function qtyStr(v: unknown) {
  return D(v as string).toDecimalPlaces(3).toString();
}
