/** Doimiy xarajatlarning muddat sanalarini hisoblash. */

const toDate = (s: string) => new Date(s + 'T00:00:00Z');
const toStr = (d: Date) => d.toISOString().slice(0, 10);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export type Period = 'daily' | 'weekly' | 'monthly';

/** start..until oralig'idagi barcha muddat sanalari (YYYY-MM-DD). */
export function dueDates(period: Period, start: string, until: string, max = 400): string[] {
  const out: string[] = [];
  const s = toDate(start);
  const u = toDate(until);
  if (s > u) return out;
  if (period === 'monthly') {
    const day = s.getUTCDate();
    let y = s.getUTCFullYear();
    let m = s.getUTCMonth();
    for (;;) {
      const d = new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m))));
      if (d > u) break;
      out.push(toStr(d));
      m++;
      if (m === 12) { m = 0; y++; }
    }
  } else {
    const step = period === 'daily' ? 1 : 7;
    for (let d = new Date(s); d <= u; d = new Date(d.getTime() + step * 86400_000)) out.push(toStr(d));
  }
  return out.slice(-max);
}

export function isDueDate(period: Period, start: string, date: string): boolean {
  if (date < start) return false;
  return dueDates(period, start, date, 1)[0] === date;
}
