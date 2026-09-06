import type { AppState, PaymentLog, RecurringExpense } from "./backend/db";

/* ------------------------------------------------------------------ */
/* Biçimlendirme                                                       */
/* ------------------------------------------------------------------ */

const tl = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 0 });
const tlExact = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" });

export const money = (n: number) => tl.format(n);
export const moneyExact = (n: number) => tlExact.format(n);
/** Yerel tarih. UTC olmaz: TR'de (UTC+3) gece 00:00-03:00 arası bir gün geriye kayar. */
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Sabit değil fonksiyon: sunucu günlerce ayakta kalır, gece yarısını geçebilmeli. */
export const today = () => localDate();

/** ISO tarihe gün ekler. */
export const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

/** Ekranda görünen uzun tarih — hesapla aynı kaynaktan gelsin diye burada. */
export const longDate = (iso = today()) =>
  // Öğlen: saat dilimi kayması gösterilen günü değiştirmesin.
  new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${iso}T12:00:00`));
export const trDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

export const daysUntil = (due: string) =>
  Math.round((Date.parse(due + "T00:00:00Z") - Date.parse(today() + "T00:00:00Z")) / 86_400_000);

/** Vade tarihini "ne zaman" sorusunun cevabına çevirir. */
export function countdown(due: string | null, settled: boolean) {
  if (settled) return { tone: "settled", head: "kapandı", tail: "" };
  if (!due) return { tone: "", head: "vadesiz", tail: "" };
  const d = daysUntil(due);
  if (d < 0) return { tone: "late", head: `${-d} gün`, tail: "gecikti" };
  if (d === 0) return { tone: "late", head: "bugün", tail: "" };
  if (d === 1) return { tone: "soon", head: "yarın", tail: "" };
  if (d < 45) return { tone: d < 8 ? "soon" : "", head: `${d} gün`, tail: "kaldı" };
  return { tone: "", head: `${Math.round(d / 30)} ay`, tail: "kaldı" };
}

/* ------------------------------------------------------------------ */
/* Takvim                                                              */
/* ------------------------------------------------------------------ */

/** "2026-09-30" + 2 ay -> "2026-11". Salt aritmetik; Date'in gün taşması sorunu yok. */
export const monthKey = (iso: string, add = 0) => {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  const t = y * 12 + (m - 1) + add;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

export const monthLabel = (key: string, opts: Intl.DateTimeFormatOptions = { month: "short" }) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("tr-TR", opts).format(new Date(y, m - 1, 1));
};

/** "2026-01-31" -> "2026-02-28". Bir sonraki ödeme/ekstre tarihini önerir. */
export const nextMonthDate = (iso: string) => {
  const key = monthKey(iso, 1);
  const [y, m] = key.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${key}-${String(Math.min(Number(iso.slice(8, 10)), last)).padStart(2, "0")}`;
};

/** Sabit giderin önümüzdeki ödemeleri — sözleşme bitince durur, ötesini uydurmaz. */
export function* occurrences(e: RecurringExpense, span: number) {
  let d = e.next_due_date;
  for (let i = 0; i < span; i++) {
    if (e.renews_on && d > e.renews_on) return;
    yield d;
    d = nextMonthDate(d);
  }
}

/* ------------------------------------------------------------------ */
/* Türetilmiş görünümler                                               */
/* ------------------------------------------------------------------ */

export interface Bucket { key: string; out: number; in: number }

/** 12 aylık nakit projeksiyonu — backend'e dokunmadan state'ten türetiliyor. */
export function forecast(s: AppState, span = 12): Bucket[] {
  const start = monthKey(today());
  const buckets = new Map<string, Bucket>(
    Array.from({ length: span }, (_, i) => [monthKey(today(), i), { key: monthKey(today(), i), out: 0, in: 0 }]),
  );
  // Vadesi geçmiş yükümlülükler ilk aya yığılır — kaybolmasınlar.
  const add = (due: string | null, side: "in" | "out", amount: number) => {
    if (!due || amount <= 0) return;
    const b = buckets.get(monthKey(due) < start ? start : monthKey(due));
    if (b) b[side] += amount;
  };

  for (const r of s.records) add(r.due_date, r.type === "receivable" ? "in" : "out", r.remaining_amount);
  for (const c of s.cards) add(c.due_date, "out", c.statement_amount);
  for (const l of s.loans) {
    for (let i = 0; i < l.total_installments - l.paid_installments; i++) {
      if (l.next_due_date) add(monthKey(l.next_due_date, i) + "-01", "out", l.installment_amount);
    }
  }
  for (const e of s.expenses) for (const d of occurrences(e, span)) add(d, "out", e.amount);
  return [...buckets.values()];
}

/** Önümüzdeki 30 gün içinde ödenmesi gereken toplam (gecikmişler dahil). */
export function dueSoon(s: AppState) {
  const items = upcoming(s, 30).filter((u) => u.direction === "out");
  return {
    total: round(items.reduce((a, b) => a + b.amount, 0)),
    late: round(items.filter((u) => u.due < today()).reduce((a, b) => a + b.amount, 0)),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

export type Kind = "record" | "card" | "loan" | "expense";

export interface Upcoming {
  kind: Kind;
  id: number;
  title: string;
  detail: string;
  due: string;
  amount: number;
  direction: "in" | "out";
}

/**
 * Bir tarih aralığına düşen tüm yükümlülük ve alacakları tek listede toplar.
 * Kredi taksitleri ve sabit giderler aralıkta kaç kez düşüyorsa o kadar üretilir —
 * "sadece sıradaki" değil; yoksa uzun pencerede eksik sayılır.
 */
export function between(s: AppState, from: string, to: string): Upcoming[] {
  const out: Upcoming[] = [];
  const hit = (d: string | null): d is string => !!d && d >= from && d <= to;

  for (const r of s.records) {
    if (r.remaining_amount > 0 && hit(r.due_date)) {
      out.push({
        kind: "record", id: r.id, title: r.person,
        detail: r.type === "receivable" ? "sana borçlu" : "ona borçlusun",
        due: r.due_date, amount: r.remaining_amount,
        direction: r.type === "receivable" ? "in" : "out",
      });
    }
  }

  for (const c of s.cards) {
    if (c.statement_amount > 0 && hit(c.due_date)) {
      out.push({
        kind: "card", id: c.id, title: c.name, detail: `asgari ${moneyExact(c.minimum_amount)}`,
        due: c.due_date, amount: c.statement_amount, direction: "out",
      });
    }
  }

  for (const l of s.loans) {
    let d = l.next_due_date;
    for (let i = l.paid_installments; d && i < l.total_installments; i++) {
      if (d > to) break;
      if (d >= from) {
        out.push({
          kind: "loan", id: l.id, title: l.name, detail: `${i + 1}. taksit / ${l.total_installments}`,
          due: d, amount: l.installment_amount, direction: "out",
        });
      }
      d = nextMonthDate(d);
    }
  }

  for (const e of s.expenses) {
    for (const d of occurrences(e, 600)) {
      if (d > to) break;
      if (d >= from) {
        out.push({ kind: "expense", id: e.id, title: e.name, detail: "sabit gider", due: d, amount: e.amount, direction: "out" });
      }
    }
  }

  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : b.amount - a.amount));
}

/** Bugünden itibaren N gün. Gecikmişler de dahildir — en acil olanlar onlar. */
export const upcoming = (s: AppState, days = 30) =>
  between(s, "0000-01-01", addDays(today(), days));

/* ------------------------------------------------------------------ */
/* Aylık ödeme listesi                                                 */
/* ------------------------------------------------------------------ */

export interface PlanRow {
  key: string;
  done: boolean;
  title: string;
  detail: string;
  date: string;
  amount: number;
  kind?: Kind;
  id?: number;
  logId?: number;
  undoable?: boolean;
}

export const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

/**
 * Bir ayın ödeme listesi: yapılmış ödemeler (payment_logs) + o ayda ödenmesi
 * gerekenler. İkisi çakışmaz — ödeme yapıldığında kayıt zaten planlamadan düşer.
 * İçinde bulunulan ayda geçmiş aylardan sarkan ödenmemişler de listeye girer.
 */
export function monthPlan(s: AppState, month: string): PlanRow[] {
  const now = monthKey(today());
  const last = monthEnd(month);

  const paid: PlanRow[] = s.logs
    .filter((l: PaymentLog) => l.paid_at.slice(0, 7) === month)
    .map((l) => ({
      key: `log:${l.id}`, done: true, title: l.note ?? "ödeme", detail: "",
      date: l.paid_at.slice(0, 10), amount: l.amount, logId: l.id, undoable: !!l.prev,
    }));

  // Geçmiş ay için "planlanan" diye bir şey yok; kayıtlar çoktan ilerledi.
  const planned: PlanRow[] =
    month < now
      ? []
      : between(s, month === now ? "0000-01-01" : `${month}-01`, last)
          .filter((u) => u.direction === "out")
          .map((u) => ({
            key: `plan:${u.kind}:${u.id}:${u.due}`, done: false, title: u.title,
            detail: u.due < today() ? `${u.detail} · gecikmiş` : u.detail,
            date: u.due, amount: u.amount, kind: u.kind, id: u.id,
          }));

  return [...paid, ...planned].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.done ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* Borç erime eğrisi                                                   */
/* ------------------------------------------------------------------ */

export interface PayoffPoint { key: string; label: string; total: number }

/**
 * Ay sonu itibarıyla kalan borç stoku — "ne zaman biter" sorusunun cevabı.
 * Sabit giderler dahil değil: onlar borç değil, sürekli akış; dahil edilse
 * eğri hiçbir zaman sıfıra inmez ve grafik yalan söyler.
 */
export function payoff(s: AppState, span = 12): PayoffPoint[] {
  const stockAt = (end: string) => {
    let t = 0;
    for (const r of s.records) {
      if (r.type === "debt" && r.remaining_amount > 0 && (!r.due_date || r.due_date > end)) t += r.remaining_amount;
    }
    for (const c of s.cards) {
      if (c.statement_amount > 0 && (!c.due_date || c.due_date > end)) t += c.statement_amount;
    }
    for (const l of s.loans) {
      const left = l.total_installments - l.paid_installments;
      if (left <= 0) continue;
      if (!l.next_due_date) { t += left * l.installment_amount; continue; }
      let d = l.next_due_date;
      let cleared = 0;
      for (let k = 0; k < left; k++) { if (d <= end) cleared++; d = nextMonthDate(d); }
      t += (left - cleared) * l.installment_amount;
    }
    return Math.round(t * 100) / 100;
  };

  const now = today();
  const points: PayoffPoint[] = [{ key: now, label: "bugün", total: stockAt(addDays(now, -1)) }];
  for (let i = 0; i < span; i++) {
    const key = monthKey(now, i);
    points.push({ key, label: monthLabel(key), total: stockAt(monthEnd(key)) });
  }
  return points;
}

/** Aya göre gerçekleşen ödemeler — boş aylar da eksende yer alır. */
export function paidByMonth(s: AppState, span = 12): { key: string; label: string; total: number }[] {
  const sums = new Map<string, number>();
  for (const l of s.logs) sums.set(l.paid_at.slice(0, 7), (sums.get(l.paid_at.slice(0, 7)) ?? 0) + l.amount);
  const now = today();
  return Array.from({ length: span }, (_, i) => {
    const key = monthKey(now, i - span + 1);
    return { key, label: monthLabel(key), total: Math.round((sums.get(key) ?? 0) * 100) / 100 };
  });
}
