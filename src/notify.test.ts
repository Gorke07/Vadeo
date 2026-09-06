import { expect, test } from "bun:test";

process.env.VADEO_DB = ":memory:";
const { collect, compose, markSent, unsent } = await import("./notify");
const { readState } = await import("./backend/routes");
const { db } = await import("./backend/db");
const { today } = await import("./shared");

// Test dosyaları aynı süreçte çalışır ve bu yüzden aynı :memory: veritabanını paylaşır.
// Her dosya kendi temiz zeminini kurar; sıradan bağımsız olsun.
for (const t of ["payment_logs", "personal_records", "credit_cards", "loans", "recurring_expenses", "sent_notifications"]) {
  db.exec(`DELETE FROM ${t}`);
}

const day = (n: number) => new Date(Date.parse(today()) + n * 86_400_000).toISOString().slice(0, 10);
const triggers = () => collect(readState()).map((e) => e.trigger);

test("bildirim: sadece aksiyon gerektirenleri toplar", () => {
  db.run("INSERT INTO personal_records (person, type, amount, remaining_amount, due_date) VALUES (?,?,?,?,?)",
    ["Selin", "debt", 900, 900, day(-3)]);                       // gecikmiş
  db.run("INSERT INTO recurring_expenses (name, amount, next_due_date, renews_on) VALUES (?,?,?,?)",
    ["Kira", 24000, day(1), day(20)]);                            // yarın + sözleşme 20 gün
  db.run("INSERT INTO credit_cards (name, statement_amount, minimum_amount, due_date) VALUES (?,?,?,?)",
    ["Bonus", 0, 0, day(-10)]);                                   // ekstre girilmemiş
  db.run("INSERT INTO personal_records (person, type, amount, remaining_amount, due_date) VALUES (?,?,?,?,?)",
    ["Uzak", "debt", 100, 100, day(200)]);                        // pencere dışı
  db.run("INSERT INTO personal_records (person, type, amount, remaining_amount, due_date) VALUES (?,?,?,?,?)",
    ["Ahmet", "receivable", 500, 500, day(0)]);                   // alacak, borç değil

  expect(new Set(triggers())).toEqual(new Set(["daily", "late", "statement", "renew"]));
  const text = compose(collect(readState()));
  expect(text).toContain("Kira");
  expect(text).not.toContain("Uzak");   // uzak vade sessiz
  expect(text).not.toContain("Ahmet");  // tahsilat hatırlatması yok, sadece ödemeler
});

test("bildirim: aynı olay iki kez gönderilmez", () => {
  const first = unsent(collect(readState()));
  expect(first.length).toBeGreaterThan(0);
  markSent(first);
  expect(unsent(collect(readState()))).toHaveLength(0);

  // vade değişip yeniden gecikirse yeni anahtar üretir, tekrar haber verir
  db.run("UPDATE personal_records SET due_date = ? WHERE person = 'Selin'", [day(-1)]);
  expect(unsent(collect(readState())).map((e) => e.trigger)).toEqual(["late"]);
});

test("bildirim: ilk satır bugün+yarın toplamını taşır", () => {
  const daily = collect(readState()).find((e) => e.trigger === "daily");
  expect(daily!.total).toBe(24000); // Kira yarın; gecikmiş Selin bu toplama girmez
  expect(compose(collect(readState())).split("\n")[0]).toContain("₺24.000,00");
});

test("bildirim: kapatılan tür hiç toplanmaz", () => {
  const only = collect(readState(), new Set(["late"] as const));
  expect(new Set(only.map((e) => e.trigger))).toEqual(new Set(["late"]));
  expect(collect(readState(), new Set())).toHaveLength(0);
});

test("bildirim: kullanıcı girdisi HTML'e kaçırılıyor", () => {
  db.run("INSERT INTO personal_records (person, type, amount, remaining_amount, due_date) VALUES (?,?,?,?,?)",
    ["<b>Hacker</b> & Co", "debt", 50, 50, day(-2)]);
  const text = compose(collect(readState()));
  expect(text).toContain("&lt;b&gt;Hacker&lt;/b&gt; &amp; Co");
  expect(text).not.toContain("<b>Hacker</b>");
});
