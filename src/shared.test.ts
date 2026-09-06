import { expect, test } from "bun:test";
import type { AppState } from "./backend/db";
import { between, forecast, monthEnd, monthKey, monthPlan, nextMonthDate, paidByMonth, payoff, today, upcoming } from "./shared";

const day = (n: number) => new Date(Date.parse(today()) + n * 86_400_000).toISOString().slice(0, 10);

const state = (over: Partial<AppState> = {}): AppState => ({
  summary: { totalReceivable: 0, totalPersonalDebt: 0, totalCardDebt: 0, totalLoanPrincipal: 0 },
  records: [], cards: [], loans: [], expenses: [], logs: [], ...over,
});

test("yaklaşanlar: dört türü tarihe göre birleştirir, gecikmişi öne alır", () => {
  const s = state({
    records: [
      { id: 1, person: "Ahmet", type: "receivable", amount: 500, remaining_amount: 500, due_date: day(10), created_at: "" },
      { id: 2, person: "Selin", type: "debt", amount: 900, remaining_amount: 900, due_date: day(-5), created_at: "" },
      { id: 3, person: "Kapalı", type: "debt", amount: 100, remaining_amount: 0, due_date: day(1), created_at: "" },
    ],
    cards: [{ id: 1, name: "Bonus", statement_amount: 2000, minimum_amount: 400, due_date: day(3), created_at: "" }],
    loans: [{ id: 1, name: "Kredi", installment_amount: 750, total_installments: 12, paid_installments: 12, next_due_date: day(2), created_at: "" }],
    expenses: [{ id: 1, name: "Kira", amount: 1200, next_due_date: day(1), renews_on: null, created_at: "" }],
  });

  const list = upcoming(s, 30);
  expect(list.map((u) => `${u.kind}:${u.title}`)).toEqual([
    "record:Selin",   // gecikmiş, en önde
    "expense:Kira",
    "card:Bonus",
    "record:Ahmet",
  ]);
  // bitmiş kredi ve kapanmış kayıt listeye girmez
  expect(list.some((u) => u.kind === "loan" || u.title === "Kapalı")).toBe(false);
  expect(list[0]!.direction).toBe("out");
  expect(list.find((u) => u.title === "Ahmet")!.direction).toBe("in");
});

test("yaklaşanlar: pencere dışını almaz", () => {
  const s = state({
    cards: [{ id: 1, name: "Uzak", statement_amount: 100, minimum_amount: 0, due_date: day(40), created_at: "" }],
  });
  expect(upcoming(s, 30)).toHaveLength(0);
  expect(upcoming(s, 60)).toHaveLength(1);
});

test("projeksiyon: sabit gider sözleşme bitince durur", () => {
  const s = state({
    expenses: [{ id: 1, name: "Kira", amount: 1000, next_due_date: today(), renews_on: monthKey(today(), 2) + "-28", created_at: "" }],
  });
  const f = forecast(s, 12);
  expect(f.slice(0, 3).map((b) => b.out)).toEqual([1000, 1000, 1000]);
  expect(f.slice(3).every((b) => b.out === 0)).toBe(true); // sözleşme bitti, uydurmuyor
});

test("ay sonu kırpması", () => {
  expect(nextMonthDate("2026-01-31")).toBe("2026-02-28");
  expect(nextMonthDate("2027-01-31")).toBe("2027-02-28");
  expect(nextMonthDate("2028-01-31")).toBe("2028-02-29"); // artık yıl
  expect(nextMonthDate("2026-12-15")).toBe("2027-01-15");
});

test("aralık: kredi taksitleri ve giderler kaç kez düşüyorsa o kadar üretilir", () => {
  const s = state({
    loans: [{ id: 1, name: "Kredi", installment_amount: 500, total_installments: 12, paid_installments: 2,
              next_due_date: "2026-09-10", created_at: "" }],
    expenses: [{ id: 1, name: "Kira", amount: 1000, next_due_date: "2026-09-05", renews_on: "2026-11-30", created_at: "" }],
  });
  // Eyl-Kas: 3 taksit + 3 kira
  const q = between(s, "2026-09-01", "2026-11-30");
  expect(q.filter((u) => u.kind === "loan")).toHaveLength(3);
  expect(q.filter((u) => u.kind === "expense")).toHaveLength(3);
  // sözleşme Kasım'da bitiyor: Aralık'ta kira yok, taksit var
  const dec = between(s, "2026-12-01", "2026-12-31");
  expect(dec.map((u) => u.kind)).toEqual(["loan"]);
  // taksit numarası ilerliyor
  expect(q.filter((u) => u.kind === "loan").map((u) => u.detail)).toEqual([
    "3. taksit / 12", "4. taksit / 12", "5. taksit / 12",
  ]);
});

test("ay sonu hesabı", () => {
  expect(monthEnd("2026-02")).toBe("2026-02-28");
  expect(monthEnd("2028-02")).toBe("2028-02-29");
  expect(monthEnd("2026-09")).toBe("2026-09-30");
});

test("aylık liste: ödenmişler ve ödenecekler tek listede, çakışmadan", () => {
  const now = monthKey(today());
  const s = state({
    expenses: [{ id: 1, name: "Kira", amount: 1000, next_due_date: `${now}-25`, renews_on: null, created_at: "" }],
    logs: [
      { id: 7, ref_table: "loans", ref_id: 1, amount: 500, note: "Kredi · 1. taksit", paid_at: `${now}-03 10:00:00`, prev: "{}" },
      { id: 8, ref_table: "loans", ref_id: 1, amount: 500, note: "Eski ay", paid_at: "2020-01-05 10:00:00", prev: null },
    ],
  });

  const rows = monthPlan(s, now);
  expect(rows.map((r) => [r.done, r.title])).toEqual([
    [true, "Kredi · 1. taksit"],   // ödenmiş, ayın 3'ü
    [false, "Kira"],               // ödenecek, ayın 25'i
  ]);
  expect(rows[0]!.undoable).toBe(true);
  expect(rows.some((r) => r.title === "Eski ay")).toBe(false);

  // geçmiş ay: yalnızca gerçekten yapılan ödemeler, uydurma plan yok
  expect(monthPlan(s, "2020-01").map((r) => r.title)).toEqual(["Eski ay"]);
  expect(monthPlan(s, "2020-01")[0]!.undoable).toBe(false);
});

test("tarih yerel saatten türer: TR'de gece yarısından sonra bir gün geriye kaymaz", () => {
  // TR saatiyle 6 Eylül 01:30 = UTC 5 Eylül 22:30.
  // Saati dondurup ayrı bir süreçte, Europe/Istanbul altında çalıştırıyoruz.
  const script = `
    const R = Date, fixed = new R("2026-09-05T22:30:00Z");
    globalThis.Date = class extends R {
      constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); }
      static now() { return fixed.getTime(); }
    };
    const { today, longDate } = await import("${import.meta.dir}/shared.ts");
    // Eski yol: dondurulmuş anı UTC'ye göre okumak. R (gerçek Date) değil, üzerine
    // yazılmış Date kullanılmalı — yoksa test o günün gerçek tarihine bağımlı olur.
    console.log(JSON.stringify({ today: today(), long: longDate(), utc: new Date().toISOString().slice(0, 10) }));
  `;
  const run = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, TZ: "Europe/Istanbul" } });
  const r = JSON.parse(run.stdout.toString().trim());

  expect(r.today).toBe("2026-09-06");          // yerel gün
  expect(r.utc).toBe("2026-09-05");            // eski yol bir gün geride kalıyordu
  expect(r.long).toBe("6 Eylül 2026");         // ekranda görünen, hesapla aynı gün
});

test("erime eğrisi: borç sıfıra iner, sabit gider eğriye karışmaz", () => {
  const now = monthKey(today());
  const s = state({
    loans: [{ id: 1, name: "Kredi", installment_amount: 1000, total_installments: 12, paid_installments: 9,
              next_due_date: `${now}-10`, created_at: "" }],                       // 3 taksit = 3000
    records: [{ id: 1, person: "A", type: "debt", amount: 500, remaining_amount: 500,
                due_date: `${now}-20`, created_at: "" }],                          // bu ay kapanıyor
    expenses: [{ id: 1, name: "Kira", amount: 9999, next_due_date: `${now}-05`, renews_on: null, created_at: "" }],
  });
  const p = payoff(s, 4).map((x) => x.total);
  expect(p[0]).toBe(3500);   // bugün: 3 taksit + 500 borç
  expect(p[1]).toBe(2000);   // bu ay sonu: 1 taksit + borç ödendi
  expect(p[2]).toBe(1000);
  expect(p[3]).toBe(0);      // sıfıra iniyor — kira dahil olsaydı inmezdi
  expect(p[4]).toBe(0);
});

test("aylık gerçekleşen: boş aylar eksende kalır", () => {
  const now = monthKey(today());
  const s = state({ logs: [
    { id: 1, ref_table: "loans", ref_id: 1, amount: 300, note: "", paid_at: `${now}-02 10:00:00`, prev: null },
    { id: 2, ref_table: "loans", ref_id: 1, amount: 200, note: "", paid_at: `${now}-09 10:00:00`, prev: null },
  ] });
  const m = paidByMonth(s, 3);
  expect(m).toHaveLength(3);
  expect(m.at(-1)!.key).toBe(now);
  expect(m.at(-1)!.total).toBe(500);      // aynı ayın ödemeleri toplanıyor
  expect(m.slice(0, 2).every((x) => x.total === 0)).toBe(true);
});
