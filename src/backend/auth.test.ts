import { expect, test } from "bun:test";

process.env.VADEO_DB = ":memory:";
const { api } = await import("./routes");
const { db } = await import("./db");
const { lockedUntil } = await import("./auth");

for (const t of ["payment_logs", "personal_records", "credit_cards", "loans", "recurring_expenses", "settings", "sessions"]) {
  db.exec(`DELETE FROM ${t}`);
}

const call = (method: string, path: string, body?: unknown, cookie?: string) =>
  api(
    new Request(`http://x${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`http://x${path}`),
  ).then(async (r) => [r.status, await r.json(), r.headers.get("set-cookie") ?? ""] as const);

const unlock = () => db.run("DELETE FROM settings WHERE key IN ('pin_fails','pin_locked_until')");

test("PIN kurulu değilken koruma yok", async () => {
  expect((await call("GET", "/api/state"))[0]).toBe(200);
  expect((await call("GET", "/api/auth"))[1].pinSet).toBe(false);
});

test("PIN kurulur, sonrasında oturumsuz istek reddedilir", async () => {
  expect((await call("POST", "/api/settings/pin", { pin: "12" }))[0]).toBe(400); // 4-8 rakam
  expect((await call("POST", "/api/settings/pin", { pin: "abcd" }))[0]).toBe(400);

  const [status, , cookie] = await call("POST", "/api/settings/pin", { pin: "8317" });
  expect(status).toBe(200);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  const session = cookie.split(";")[0]!;

  // PIN'i kuran cihaz açık kalır, başkası kalmaz
  expect((await call("GET", "/api/state", undefined, session))[0]).toBe(200);
  expect((await call("GET", "/api/state"))[0]).toBe(401);
  // yedek de korumalı: o dosya veritabanının tamamı
  expect((await call("GET", "/api/backup"))[0]).toBe(401);
  expect((await call("PATCH", "/api/settings", { theme: "dark" }))[0]).toBe(401);
});

test("yanlış PIN girişi vermez, doğru PIN oturum açar", async () => {
  unlock();
  expect((await call("POST", "/api/auth", { pin: "0000" }))[0]).toBe(401);
  unlock();
  const [status, , cookie] = await call("POST", "/api/auth", { pin: "8317" });
  expect(status).toBe(200);
  expect((await call("GET", "/api/state", undefined, cookie.split(";")[0]))[0]).toBe(200);
});

test("kaba kuvvet: 5. hatadan sonra kilitleniyor ve süre katlanıyor", async () => {
  unlock();
  for (let i = 0; i < 4; i++) expect((await call("POST", "/api/auth", { pin: "0000" }))[1].error).toBe("PIN yanlış");
  expect(lockedUntil()).toBeNull();

  // 5. hata kilidi başlatır
  const [, beşinci] = await call("POST", "/api/auth", { pin: "0000" });
  expect(beşinci.error).toContain("bekle");
  expect(lockedUntil()).not.toBeNull();

  // kilitliyken DOĞRU pin bile kabul edilmez
  expect((await call("POST", "/api/auth", { pin: "8317" }))[0]).toBe(401);

  const ilk = lockedUntil()!.getTime();
  db.run("DELETE FROM settings WHERE key = 'pin_locked_until'"); // süreyi bekleme, sadece sayacı koru
  await call("POST", "/api/auth", { pin: "0000" });              // 6. hata
  expect(lockedUntil()!.getTime() - Date.now()).toBeGreaterThan(ilk - Date.now()); // süre uzadı
});

test("doğru PIN sayacı sıfırlar", async () => {
  unlock();
  await call("POST", "/api/auth", { pin: "0000" });
  const [ok, , cookie] = await call("POST", "/api/auth", { pin: "8317" });
  expect(ok).toBe(200);
  expect(db.query<{ v: string }, []>("SELECT value v FROM settings WHERE key='pin_fails'").get()).toBeNull();

  // çıkış oturumu düşürür
  const session = cookie.split(";")[0]!;
  expect((await call("DELETE", "/api/auth", undefined, session))[0]).toBe(200);
  expect((await call("GET", "/api/state", undefined, session))[0]).toBe(401);
});

test("PIN değişimi mevcut PIN'i ister ve diğer oturumları düşürür", async () => {
  unlock();
  const [, , c1] = await call("POST", "/api/auth", { pin: "8317" });
  const [, , c2] = await call("POST", "/api/auth", { pin: "8317" });
  const eski = c1.split(";")[0]!;

  expect((await call("POST", "/api/settings/pin", { pin: "5555" }, c2.split(";")[0]))[0]).toBe(400); // current yok
  const [status, , yeni] = await call("POST", "/api/settings/pin", { pin: "5555", current: "8317" }, c2.split(";")[0]);
  expect(status).toBe(200);
  expect((await call("GET", "/api/state", undefined, eski))[0]).toBe(401);         // diğer cihaz düştü
  expect((await call("GET", "/api/state", undefined, yeni.split(";")[0]))[0]).toBe(200);

  unlock();
  expect((await call("POST", "/api/auth", { pin: "8317" }))[0]).toBe(401);         // eski PIN geçmez
  unlock();
  expect((await call("POST", "/api/auth", { pin: "5555" }))[0]).toBe(200);
});

test("PIN kaldırma mevcut PIN'i ister", async () => {
  unlock();
  const [, , c] = await call("POST", "/api/auth", { pin: "5555" });
  expect((await call("POST", "/api/settings/pin", { pin: "", current: "0000" }, c.split(";")[0]))[0]).toBe(400);
  expect((await call("POST", "/api/settings/pin", { pin: "", current: "5555" }, c.split(";")[0]))[0]).toBe(200);
  expect((await call("GET", "/api/state"))[0]).toBe(200); // koruma kalktı
});
