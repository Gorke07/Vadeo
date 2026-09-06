import { expect, test } from "bun:test";

// db.ts yolu env'den okuyor; import'tan ÖNCE bellek içi veritabanına çevir.
process.env.VADEO_DB = ":memory:";
const { api } = await import("./routes");
const { db } = await import("./db");

// Test dosyaları aynı süreçte çalışır ve bu yüzden aynı :memory: veritabanını paylaşır.
// Her dosya kendi temiz zeminini kurar; sıradan bağımsız olsun.
for (const t of ["payment_logs", "personal_records", "credit_cards", "loans", "recurring_expenses", "sent_notifications"]) {
  db.exec(`DELETE FROM ${t}`);
}

const call = (method: string, path: string, body?: unknown) =>
  api(
    new Request(`http://x${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`http://x${path}`),
  ).then(async (r) => [r.status, await r.json()] as const);

test("kısmi ödeme kalanı düşürür, fazla ödeme kalanı aşamaz", async () => {
  let [status, s] = await call("POST", "/api/records", { person: "Ali", type: "receivable", amount: 1000 });
  expect(status).toBe(201);
  const id = s.records[0].id;

  [, s] = await call("POST", `/api/records/${id}/pay`, { amount: 300 });
  expect(s.records[0].remaining_amount).toBe(700);
  expect(s.summary.totalReceivable).toBe(700);

  [, s] = await call("POST", `/api/records/${id}/pay`, { amount: 99999 });
  expect(s.records[0].remaining_amount).toBe(0);
  expect(s.logs[0].amount).toBe(700); // kalan kadar loglandı, 99999 değil

  const [bad] = await call("POST", `/api/records/${id}/pay`, { amount: 10 });
  expect(bad).toBe(400); // kalanı olmayan kayda ödeme yok
});

test("kart: asgari ve tam kapatma", async () => {
  let [, s] = await call("POST", "/api/cards", { name: "Bonus", statement_amount: 1000, minimum_amount: 200 });
  const id = s.cards[0].id;

  [, s] = await call("POST", `/api/cards/${id}/pay`, { mode: "min" });
  expect(s.cards[0].statement_amount).toBe(800);

  [, s] = await call("POST", `/api/cards/${id}/pay`, { mode: "full" });
  expect(s.cards[0].statement_amount).toBe(0);
  expect(s.cards[0].minimum_amount).toBe(0);
  expect(s.summary.totalCardDebt).toBe(0);
});

test("kredi: taksit öde, vade bir ay ilerler, toplam taksit aşılamaz", async () => {
  let [, s] = await call("POST", "/api/loans", {
    name: "İhtiyaç",
    installment_amount: 500,
    total_installments: 2,
    next_due_date: "2026-01-31",
  });
  const id = s.loans[0].id;
  expect(s.summary.totalLoanPrincipal).toBe(1000);

  [, s] = await call("POST", `/api/loans/${id}/pay`, {});
  expect(s.loans[0].paid_installments).toBe(1);
  expect(s.loans[0].next_due_date).toBe("2026-02-28"); // ay sonu kırpması
  expect(s.summary.totalLoanPrincipal).toBe(500);

  await call("POST", `/api/loans/${id}/pay`, {});
  const [status] = await call("POST", `/api/loans/${id}/pay`, {});
  expect(status).toBe(400);
});

test("kart: yeni dönem ekstresi kartın üzerine yazılır", async () => {
  let [, s] = await call("POST", "/api/cards", { name: "World", statement_amount: 500, minimum_amount: 100 });
  const id = s.cards.find((c: { name: string }) => c.name === "World").id;
  await call("POST", `/api/cards/${id}/pay`, { mode: "full" });

  [, s] = await call("POST", `/api/cards/${id}/statement`, {
    statement_amount: 2200,
    minimum_amount: 440,
    due_date: "2026-10-20",
  });
  const card = s.cards.find((c: { id: number }) => c.id === id);
  expect(card.statement_amount).toBe(2200);
  expect(card.minimum_amount).toBe(440);
  expect(card.due_date).toBe("2026-10-20");

  // asgari, dönem borcunu asamaz
  expect((await call("POST", `/api/cards/${id}/statement`, { statement_amount: 100, minimum_amount: 900 }))[0]).toBe(400);
  expect((await call("POST", "/api/cards/9999/statement", { statement_amount: 10, minimum_amount: 1 }))[0]).toBe(400);
});

test("geri alma: ödemeyi alanlarıyla birlikte eski haline döndürür", async () => {
  let [, s] = await call("POST", "/api/cards", { name: "Geri", statement_amount: 1000, minimum_amount: 300 });
  const card = (t: typeof s) => t.cards.find((c: { name: string }) => c.name === "Geri");
  const id = card(s).id;

  // asgari ödeme, asgariyi kalan borca kırpar: 1000->700, asgari 300 kalır
  [, s] = await call("POST", `/api/cards/${id}/pay`, { mode: "min" });
  expect(card(s).statement_amount).toBe(700);

  // tümünü kapat: asgari de 0'a kırpılır — geri alma ikisini de geri yazmalı
  [, s] = await call("POST", `/api/cards/${id}/pay`, { mode: "full" });
  expect(card(s).minimum_amount).toBe(0);

  const logId = s.logs[0].id;
  [, s] = await call("POST", `/api/payments/${logId}/undo`);
  expect(card(s).statement_amount).toBe(700);
  expect(card(s).minimum_amount).toBe(300); // kırpılan asgari geri geldi
  expect(s.logs.some((l: { id: number }) => l.id === logId)).toBe(false);

  expect((await call("POST", `/api/payments/${logId}/undo`))[0]).toBe(400); // iki kez geri alınamaz
});

test("düzenleme: tutar değişse de ödenmiş kısım korunur", async () => {
  let [, s] = await call("POST", "/api/records", { person: "Veli", type: "debt", amount: 1000 });
  const id = s.records.find((r: { person: string }) => r.person === "Veli").id;
  await call("POST", `/api/records/${id}/pay`, { amount: 400 });

  // 1000 -> 1200: 400 ödenmişti, kalan 800 olmalı
  [, s] = await call("PATCH", `/api/records/${id}`, { amount: 1200 });
  let row = s.records.find((r: { id: number }) => r.id === id);
  expect(row.remaining_amount).toBe(800);
  expect(row.person).toBe("Veli"); // dokunulmayan alan korundu

  // ödenmişin altına düşürülürse kalan sıfırlanır, eksiye inmez
  [, s] = await call("PATCH", `/api/records/${id}`, { amount: 250, person: "Veli Bey" });
  row = s.records.find((r: { id: number }) => r.id === id);
  expect(row.remaining_amount).toBe(0);
  expect(row.person).toBe("Veli Bey");

  expect((await call("PATCH", "/api/loans/9999", { name: "yok" }))[0]).toBe(400);
});

test("sabit gider: ödeme bir ay ilerletir, yenilenme tarihi doğrulanır", async () => {
  let [status, s] = await call("POST", "/api/expenses", {
    name: "Kira",
    amount: 24000,
    next_due_date: "2026-09-05",
    renews_on: "2027-08-31",
  });
  expect(status).toBe(201);
  const id = s.expenses[0].id;

  [, s] = await call("POST", `/api/expenses/${id}/pay`);
  expect(s.expenses[0].next_due_date).toBe("2026-10-05");

  // yenilenme: yeni tutar ve yeni sözleşme bitişi
  [, s] = await call("PATCH", `/api/expenses/${id}`, { amount: 31000, renews_on: "2028-08-31" });
  expect(s.expenses[0].amount).toBe(31000);
  expect(s.expenses[0].renews_on).toBe("2028-08-31");

  // yenilenme, ödeme tarihinden önce olamaz
  expect((await call("PATCH", `/api/expenses/${id}`, { renews_on: "2020-01-01" }))[0]).toBe(400);

  // geri alma gideri de kapsar
  [, s] = await call("POST", `/api/payments/${s.logs[0].id}/undo`);
  expect(s.expenses[0].next_due_date).toBe("2026-09-05");
});

test("yedek: canlı sqlite anlık görüntüsü döner", async () => {
  const { api } = await import("./routes");
  const res = await api(new Request("http://x/api/backup"), new URL("http://x/api/backup"));
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes.length).toBeGreaterThan(1000);
  expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3");
});

test("ayarlar: token biçimi doğrulanır ve dışarı sızmaz", async () => {
  // Gerçek bir token değil: yalnızca biçim doğrulamasını ve yanıtta sızmadığını sınar.
  const SAHTE_TOKEN = "123456789:AAEhBOweik6ad9r_ABCDEFGHIJKLMNOP1234";
  expect((await call("PATCH", "/api/settings", { telegram_token: "bozuk" }))[0]).toBe(400);
  expect((await call("PATCH", "/api/settings", { telegram_chat: "abc" }))[0]).toBe(400);
  expect((await call("PATCH", "/api/settings", { notify_hours: "22-9" }))[0]).toBe(400);
  expect((await call("PATCH", "/api/settings", { triggers: "daily,uydurma" }))[0]).toBe(400);

  const [status, s] = await call("PATCH", "/api/settings", {
    telegram_token: SAHTE_TOKEN, telegram_chat: "987654321", notify_hours: "8-23", triggers: "daily,late",
  });
  expect(status).toBe(200);
  expect(s.settings.telegramConfigured).toBe(true);
  expect(s.settings.triggers).toEqual(["daily", "late"]);
  // Token hiçbir koşulda yanıtta dönmez.
  expect(JSON.stringify(s)).not.toContain(SAHTE_TOKEN);
  expect(JSON.stringify(s)).not.toContain("AAEhBOweik");

  // Boş değer kayıtlı ayarı siler.
  const [, cleared] = await call("PATCH", "/api/settings", { telegram_token: "" });
  expect(cleared.settings.telegramConfigured).toBe(false);
});

test("geçersiz girdi 400 döner", async () => {
  expect((await call("POST", "/api/records", { person: "", type: "debt", amount: 5 }))[0]).toBe(400);
  expect((await call("POST", "/api/records", { person: "X", type: "debt", amount: -5 }))[0]).toBe(400);
  expect((await call("POST", "/api/cards", { name: "K", statement_amount: 100, minimum_amount: 500 }))[0]).toBe(400);
  expect((await call("GET", "/api/yok"))[0]).toBe(404);
});

test("geri yükleme: yedek aynen geri gelir, bozuk dosya veriye dokunmaz", async () => {
  // temiz zemin
  const { db } = await import("./db");
  for (const t of ["payment_logs", "personal_records", "credit_cards", "loans", "recurring_expenses", "settings"]) {
    db.exec(`DELETE FROM ${t}`);
  }

  await call("POST", "/api/records", { person: "Yedek Ali", type: "debt", amount: 750 });
  await call("POST", "/api/cards", { name: "Yedek Kart", statement_amount: 1200, minimum_amount: 240 });
  await call("PATCH", "/api/settings", { notify_hours: "7-21" });

  // Yedeği gerçek bir DOSYA veritabanından üret: canlı kurulum WAL modunda ve
  // WAL'lı bir dosya deserialize edilemiyor. :memory: ile üretilen yedek bu yolu sınamaz.
  const { Database } = await import("bun:sqlite");
  const tmp = `${require("node:os").tmpdir()}/vadeo-test-${crypto.randomUUID()}.sqlite`;
  const file = new Database(tmp, { create: true });
  file.exec("PRAGMA journal_mode = WAL");
  for (const t of ["personal_records", "credit_cards", "loans", "recurring_expenses", "payment_logs", "settings", "sent_notifications"]) {
    file.exec(db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?").get(t)!.sql);
    for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM ${t}`).all()) {
      const cols = Object.keys(row);
      file.run(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map((c) => row[c] as string | number | null));
    }
  }
  const dump = file.serialize();
  file.close();
  require("node:fs").rmSync(tmp, { force: true });
  require("node:fs").rmSync(tmp + "-wal", { force: true });
  require("node:fs").rmSync(tmp + "-shm", { force: true });

  const { api } = await import("./routes");

  // yedekten sonra her şeyi boz
  await call("POST", "/api/records", { person: "Sonradan", type: "debt", amount: 999 });
  const [, changed] = await call("DELETE", `/api/cards/${(await call("GET", "/api/state"))[1].cards[0].id}`);
  expect(changed.cards).toHaveLength(0);

  const restore = (body: Uint8Array) =>
    api(new Request("http://x/api/restore", { method: "POST", body }), new URL("http://x/api/restore"))
      .then(async (r) => [r.status, await r.json()] as const);

  // bozuk dosya reddedilir ve mevcut veriye dokunulmaz
  const [bad] = await restore(new TextEncoder().encode("bu bir sqlite dosyası değil ama yeterince uzun".repeat(20)));
  expect(bad).toBe(400);
  expect((await call("GET", "/api/state"))[1].records.some((r: { person: string }) => r.person === "Sonradan")).toBe(true);

  // gerçek yedek geri gelir
  const [status, s] = await restore(dump);
  expect(status).toBe(200);
  expect(s.records.map((r: { person: string }) => r.person)).toEqual(["Yedek Ali"]);
  expect(s.cards.map((c: { name: string }) => c.name)).toEqual(["Yedek Kart"]);
  expect(s.records[0].remaining_amount).toBe(750);
  expect(s.settings.notifyHours).toBe("7-21");     // ayarlar da yedeğin parçası
  expect(s.stats.records).toBe(1);
});

test("tema ayarı doğrulanır", async () => {
  expect((await call("PATCH", "/api/settings", { theme: "uydurma" }))[0]).toBe(400);
  const [, s] = await call("PATCH", "/api/settings", { theme: "light" });
  expect(s.settings.theme).toBe("light");
});

test("kart: asgari oranı ekstreden öğreniliyor ve elle değişince güncelleniyor", async () => {
  const { db } = await import("./db");
  db.exec("DELETE FROM credit_cards");

  let [, s] = await call("POST", "/api/cards", { name: "Oran", statement_amount: 10000, minimum_amount: 2000 });
  const card = (t: typeof s) => t.cards.find((c: { name: string }) => c.name === "Oran");
  expect(card(s).min_ratio).toBe(0.2);

  // yeni ekstre aynı oranla girilirse oran değişmez
  [, s] = await call("POST", `/api/cards/${card(s).id}/statement`, { statement_amount: 7250, minimum_amount: 1450 });
  expect(card(s).min_ratio).toBe(0.2);

  // elle farklı bir asgari girilirse yeni oran öğrenilir
  [, s] = await call("POST", `/api/cards/${card(s).id}/statement`, { statement_amount: 7250, minimum_amount: 2175 });
  expect(card(s).min_ratio).toBe(0.3);

  // borcu sıfırlanan karttan oran öğrenilemez; eskisi korunur
  [, s] = await call("POST", `/api/cards/${card(s).id}/pay`, { mode: "full" });
  expect(card(s).statement_amount).toBe(0);
  [, s] = await call("PATCH", `/api/cards/${card(s).id}`, { statement_amount: 0, minimum_amount: 0 });
  expect(card(s).min_ratio).toBe(0.3);
});


test("ad önerileri: ayarlardan düzenlenir, temizlenir, boşalınca varsayılana döner", async () => {
  const { db } = await import("./db");
  db.exec("DELETE FROM settings WHERE key LIKE 'names_%'");

  const [, ilk] = await call("GET", "/api/state");
  expect(ilk.settings.names.kart).toContain("Bonus");
  const varsayilanSayi = ilk.settings.names.kart.length;

  // boş satır, baştaki/sondaki boşluk ve tekrar temizlenir
  const [status, s] = await call("PATCH", "/api/settings", {
    names_kart: "Bonus\n\n  Şirket Kartı  \nBonus\nWorld\n",
  });
  expect(status).toBe(200);
  expect(s.settings.names.kart).toEqual(["Bonus", "Şirket Kartı", "World"]);
  expect(s.settings.names.kredi).toHaveLength(ilk.settings.names.kredi.length); // diğer listeler etkilenmez

  // boşaltmak varsayılana döndürür
  const [, bos] = await call("PATCH", "/api/settings", { names_kart: "   \n \n" });
  expect(bos.settings.names.kart).toHaveLength(varsayilanSayi);

  // sınırlar
  const yuz1 = Array.from({ length: 101 }, (_, i) => `k${i}`).join("\n");
  expect((await call("PATCH", "/api/settings", { names_kart: yuz1 }))[0]).toBe(400);
  expect((await call("PATCH", "/api/settings", { names_kart: "iyi\nk\u0007tu" }))[0]).toBe(400);

  // uzun ad reddedilmez, kırpılır
  const [, uzun] = await call("PATCH", "/api/settings", { names_kart: "x".repeat(200) });
  expect(uzun.settings.names.kart[0]!.length).toBe(120);
});
