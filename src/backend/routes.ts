import { Database } from "bun:sqlite";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  db,
  type AppState,
  type CreditCard,
  type Loan,
  type PersonalRecord,
  type PaymentLog,
  type RecurringExpense,
  type DataStats,
  type Summary,
  DATA_TABLES,
} from "./db";
import { forgetSent, previewNotification, sendTest, TRIGGERS, type Trigger } from "../notify";
import { NAME_LISTS, publicSettings, readSettings, saveSettings, THEMES, type NameList, type Theme } from "./settings";
import {
  authorized, clearCookie, clearPin, cookieOf, createSession, dropSession, isPinSet,
  lockedUntil, sessionCookie, setPin, verifyPin,
} from "./auth";

/* ------------------------------------------------------------------ */
/* Girdi doğrulama (güven sınırı — burada gevşetme)                    */
/* ------------------------------------------------------------------ */

const money = (v: unknown, name: string): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} pozitif bir tutar olmalı`);
  return Math.round(n * 100) / 100;
};

const money0 = (v: unknown, name: string): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "0").replace(",", ".") || "0");
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} negatif olamaz`);
  return Math.round(n * 100) / 100;
};

const text = (v: unknown, name: string): string => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`${name} zorunlu`);
  if (t.length > 120) throw new Error(`${name} en fazla 120 karakter olabilir`);
  return t;
};

const date = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error("Tarih YYYY-AA-GG biçiminde olmalı");
  return t;
};

const count = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1000) throw new Error(`${name} 1-1000 arası tam sayı olmalı`);
  return n;
};

/** Kartın asgari oranı. Ekstre sıfırsa oran öğrenilemez; eskisi korunur. */
const ratioOf = (statement: number, minimum: number) =>
  statement > 0 ? Math.round((minimum / statement) * 10000) / 10000 : null;

const idOf = (raw: string | undefined): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Geçersiz id");
  return n;
};

/* ------------------------------------------------------------------ */
/* Sorgular                                                            */
/* ------------------------------------------------------------------ */

export const readState = (): AppState => {
  const records = db.query<PersonalRecord, []>(
    "SELECT * FROM personal_records ORDER BY (remaining_amount = 0), due_date IS NULL, due_date, id",
  ).all();
  const cards = db.query<CreditCard, []>("SELECT * FROM credit_cards ORDER BY due_date IS NULL, due_date, id").all();
  const loans = db.query<Loan, []>("SELECT * FROM loans ORDER BY next_due_date IS NULL, next_due_date, id").all();
  const expenses = db.query<RecurringExpense, []>("SELECT * FROM recurring_expenses ORDER BY next_due_date, id").all();
  const logs = db.query<PaymentLog, []>("SELECT * FROM payment_logs ORDER BY id DESC LIMIT 500").all();

  const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;
  const summary: Summary = {
    totalReceivable: sum(records.filter((r) => r.type === "receivable").map((r) => r.remaining_amount)),
    totalPersonalDebt: sum(records.filter((r) => r.type === "debt").map((r) => r.remaining_amount)),
    totalCardDebt: sum(cards.map((c) => c.statement_amount)),
    // ponytail: kalan anapara = kalan taksit x taksit tutarı (faiz/anapara ayrıştırması yok).
    // Amortisman tablosu gerekiyorsa loans'a faiz oranı ekleyip burayı değiştir.
    totalLoanPrincipal: sum(loans.map((l) => (l.total_installments - l.paid_installments) * l.installment_amount)),
  };
  const one = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  const stats: DataStats = {
    records: records.length,
    cards: cards.length,
    loans: loans.length,
    expenses: expenses.length,
    logs: one("SELECT count(*) n FROM payment_logs"),
    bytes: one("SELECT page_count * page_size n FROM pragma_page_count(), pragma_page_size()"),
    since: db.query<{ d: string | null }, []>(
      "SELECT min(created_at) d FROM (SELECT created_at FROM personal_records UNION ALL SELECT created_at FROM credit_cards UNION ALL SELECT created_at FROM loans UNION ALL SELECT created_at FROM recurring_expenses)",
    ).get()?.d ?? null,
  };
  return { summary, records, cards, loans, expenses, logs, settings: publicSettings(), stats };
};

const log = (table: string, id: number, amount: number, note: string, prev: Record<string, unknown>) =>
  // Yerel saat: ay dökümü kullanıcının gece yarısına göre bölünmeli, UTC'ye göre değil.
  db.run("INSERT INTO payment_logs (ref_table, ref_id, amount, note, prev, paid_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))", [
    table,
    id,
    amount,
    note,
    JSON.stringify(prev),
  ]);

/* Ödeme uygulama — hepsi tek transaction, kısmi ödeme kalanı aşamaz. */

const payRecord = db.transaction((id: number, requested: number) => {
  const row = db.query<{ remaining_amount: number; person: string }, [number]>(
    "SELECT remaining_amount, person FROM personal_records WHERE id = ?",
  ).get(id);
  if (!row) throw new Error("Kayıt bulunamadı");
  const applied = Math.min(requested, row.remaining_amount);
  if (applied <= 0) throw new Error("Bu kaydın kalan tutarı yok");
  db.run("UPDATE personal_records SET remaining_amount = remaining_amount - ? WHERE id = ?", [applied, id]);
  log("personal_records", id, applied, `${row.person} · ${applied < row.remaining_amount ? "kısmi ödeme" : "kapandı"}`, {
    remaining_amount: row.remaining_amount,
  });
  return applied;
});

const payCard = db.transaction((id: number, mode: string, custom: number) => {
  const card = db.query<CreditCard, [number]>("SELECT * FROM credit_cards WHERE id = ?").get(id);
  if (!card) throw new Error("Kart bulunamadı");
  const requested = mode === "min" ? card.minimum_amount : mode === "full" ? card.statement_amount : custom;
  const applied = Math.round(Math.min(requested, card.statement_amount) * 100) / 100;
  if (applied <= 0) throw new Error("Kartın güncel borcu yok");
  const statement = Math.round((card.statement_amount - applied) * 100) / 100;
  db.run("UPDATE credit_cards SET statement_amount = ?, minimum_amount = min(minimum_amount, ?) WHERE id = ?", [
    statement,
    statement,
    id,
  ]);
  log("credit_cards", id, applied, `${card.name} · ${mode === "min" ? "asgari ödeme" : mode === "full" ? "borç kapatıldı" : "kısmi ödeme"}`, {
    statement_amount: card.statement_amount,
    minimum_amount: card.minimum_amount,
  });
  return applied;
});

/* Vadeyi bir ay ileri al; ayın son gününü aşan günleri kırp (31 Ocak -> 28/29 Şubat). */
const addMonth = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
};

const payLoan = db.transaction((id: number) => {
  const loan = db.query<Loan, [number]>("SELECT * FROM loans WHERE id = ?").get(id);
  if (!loan) throw new Error("Kredi bulunamadı");
  if (loan.paid_installments >= loan.total_installments) throw new Error("Kredinin tüm taksitleri ödenmiş");
  const next = loan.next_due_date ? addMonth(loan.next_due_date) : null;
  db.run("UPDATE loans SET paid_installments = paid_installments + 1, next_due_date = ? WHERE id = ?", [next, id]);
  log("loans", id, loan.installment_amount, `${loan.name} · ${loan.paid_installments + 1}. taksit / ${loan.total_installments}`, {
    paid_installments: loan.paid_installments,
    next_due_date: loan.next_due_date,
  });
  return loan.installment_amount;
});

const payExpense = db.transaction((id: number) => {
  const e = db.query<RecurringExpense, [number]>("SELECT * FROM recurring_expenses WHERE id = ?").get(id);
  if (!e) throw new Error("Gider bulunamadı");
  db.run("UPDATE recurring_expenses SET next_due_date = ? WHERE id = ?", [addMonth(e.next_due_date), id]);
  log("recurring_expenses", id, e.amount, `${e.name} · aylık ödeme`, { next_due_date: e.next_due_date });
  return e.amount;
});

/* Geri alma: ödemenin bozduğu alanları payment_logs.prev'ten aynen geri yazar.
   Tablo ve kolon adları yalnızca bu beyaz listeden geldiği için SQL'e gömmek güvenli. */
const UNDOABLE: Record<string, string[]> = {
  personal_records: ["remaining_amount"],
  credit_cards: ["statement_amount", "minimum_amount"],
  loans: ["paid_installments", "next_due_date"],
  recurring_expenses: ["next_due_date"],
};

const undoPayment = db.transaction((logId: number) => {
  const entry = db.query<PaymentLog, [number]>("SELECT * FROM payment_logs WHERE id = ?").get(logId);
  if (!entry) throw new Error("Hareket bulunamadı");
  const allowed = UNDOABLE[entry.ref_table];
  if (!allowed || !entry.prev) throw new Error("Bu hareket geri alınamıyor");
  const prev = JSON.parse(entry.prev) as Record<string, unknown>;
  const keys = allowed.filter((k) => k in prev);
  if (keys.length === 0) throw new Error("Bu hareket geri alınamıyor");
  const changed = db.run(
    `UPDATE ${entry.ref_table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...keys.map((k) => prev[k] as string | number | null), entry.ref_id],
  ).changes;
  if (!changed) throw new Error("İlgili kayıt silinmiş, geri alınamıyor");
  db.run("DELETE FROM payment_logs WHERE id = ?", [logId]);
  return entry.amount;
});

const remove = (table: "personal_records" | "credit_cards" | "loans" | "recurring_expenses", id: number) => {
  const changes = db.run(`DELETE FROM ${table} WHERE id = ?`, [id]).changes;
  if (!changes) throw new Error("Kayıt bulunamadı");
  db.run("DELETE FROM payment_logs WHERE ref_table = ? AND ref_id = ?", [table, id]);
};

/* ------------------------------------------------------------------ */
/* REST yönlendirme:  /api/<resource>/<id?>/<action?>                  */
/* ------------------------------------------------------------------ */

export async function api(req: Request, url: URL): Promise<Response> {
  const [, , resource, rawId, action] = url.pathname.split("/");
  const method = req.method;

  try {
    /* --- Kapı. Giriş uçları dışında her şey PIN ister; yedek indirme dahil,
           çünkü o dosya veritabanının tamamı. --- */
    if (resource === "auth") {
      if (method === "GET") {
        const until = lockedUntil();
        return Response.json({
          pinSet: isPinSet(),
          authorized: authorized(req),
          lockedForSeconds: until ? Math.ceil((until.getTime() - Date.now()) / 1000) : 0,
        });
      }
      if (method === "POST") {
        const { pin } = (await req.json().catch(() => ({}))) as { pin?: string };
        const r = await verifyPin(String(pin ?? ""));
        if (!r.ok) {
          return Response.json(
            { error: r.waitSeconds ? `Çok fazla hatalı deneme. ${r.waitSeconds} sn bekle.` : "PIN yanlış" },
            { status: 401 },
          );
        }
        return Response.json(readState(), { headers: { "Set-Cookie": sessionCookie(createSession()) } });
      }
      if (method === "DELETE") {
        dropSession(cookieOf(req));
        return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
      }
    }

    if (!authorized(req)) return Response.json({ error: "PIN gerekli" }, { status: 401 });

    // Yedekten geri yükleme. Dosya diske yazılmaz, canlı bağlantı değiştirilmez:
    // yedek bellekte açılır, satırlar tek transaction içinde aktarılır. Doğrulama
    // başarısızsa mevcut veriye hiç dokunulmamış olur.
    if (resource === "restore" && method === "POST") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength < 512) throw new Error("Dosya geçersiz veya boş");
      if (bytes.byteLength > 64 * 1024 * 1024) throw new Error("Dosya 64 MB sınırını aşıyor");
      if (new TextDecoder().decode(bytes.slice(0, 15)) !== "SQLite format 3") {
        throw new Error("Bu bir Vadeo yedeği değil (SQLite dosyası bekleniyor)");
      }

      // Database.deserialize() WAL modunda serileştirilmiş dosyayı açamıyor (Bun 1.4),
      // bu yüzden geçici dosyaya yazıp salt okunur açıyoruz. Dosya finally'de siliniyor.
      const tmp = `${tmpdir()}/vadeo-restore-${crypto.randomUUID()}.sqlite`;
      await Bun.write(tmp, bytes);
      let src: Database;
      try {
        src = new Database(tmp, { readonly: true });
      } catch {
        await unlink(tmp).catch(() => {});
        throw new Error("Yedek dosyası okunamadı");
      }
      try {
        const found = new Set(
          src.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
        );
        const missing = DATA_TABLES.filter((t) => !found.has(t));
        if (missing.length) throw new Error(`Yedekte şu tablolar yok: ${missing.join(", ")}`);

        const rows = Object.fromEntries(
          DATA_TABLES.map((t) => [t, src.query<Record<string, unknown>, []>(`SELECT * FROM ${t}`).all()]),
        );

        // PIN erişim kimliği, mali veri değil: yedekten gelen PIN'i uygulamıyoruz.
        // Aksi halde eski bir yedeği yüklemek seni kendi uygulamandan kilitleyebilir.
        const keepPin = readSettings();
        db.transaction(() => {
          for (const t of [...DATA_TABLES].reverse()) db.run(`DELETE FROM ${t}`);
          for (const t of DATA_TABLES) {
            for (const row of rows[t]!) {
              const cols = Object.keys(row);
              db.run(
                `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
                cols.map((c) => row[c] as string | number | null),
              );
            }
          }
          for (const k of ["pin_hash", "pin_fails", "pin_locked_until"]) {
            db.run("DELETE FROM settings WHERE key = ?", [k]);
            if (keepPin[k]) db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [k, keepPin[k]!]);
          }
        })();
      } finally {
        src.close();
        await unlink(tmp).catch(() => {});
      }
      return Response.json(readState());
    }


    // Gövde JSON olarak burada tüketiliyor; ikili yükleyen uç noktalar yukarıda kalmalı.
    const body: Record<string, unknown> =
      method === "POST" || method === "PATCH"
        ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
        : {};
    // Düzenlemede boş bırakılan alan mevcut değeri korur.
    const keep = <T,>(v: unknown, current: T) => (v === undefined ? current : v);

    if (resource === "state" && method === "GET") return Response.json(readState());

    // Yedek: canlı anlık görüntü. WAL'ı beklemeden tutarlı tek dosya verir.
    if (resource === "backup" && method === "GET") {
      return new Response(db.serialize(), {
        headers: {
          "Content-Type": "application/vnd.sqlite3",
          "Content-Disposition": `attachment; filename="vadeo-${new Date().toISOString().slice(0, 10)}.sqlite"`,
        },
      });
    }

    if (resource === "settings" && method === "POST" && rawId === "pin") {
      // Gövde yukarıda bir kez okundu; ikinci kez okunamaz.
      if (body.pin === "" || body.pin === undefined) {
        await clearPin(String(body.current ?? ""));
      } else {
        await setPin(String(body.pin), body.current === undefined ? undefined : String(body.current));
      }
      // PIN değişiminde tüm oturumlar düşer; bu isteği yapan cihaz açık kalsın.
      const headers = isPinSet() ? { "Set-Cookie": sessionCookie(createSession()) } : { "Set-Cookie": clearCookie() };
      return Response.json(readState(), { headers });
    }

    if (resource === "settings" && method === "PATCH") {
      const values: Record<string, string> = {};

      if (body.telegram_token !== undefined) {
        const t = String(body.telegram_token).trim();
        // Boş gelirse kayıtlı token silinir; doluysa biçimi tutmalı (yapıştırma hatasını erken yakala).
        if (t && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error("Bot token biçimi hatalı (123456:ABC-DEF... bekleniyor)");
        values.telegram_token = t;
      }
      if (body.telegram_chat !== undefined) {
        const c = String(body.telegram_chat).trim();
        if (c && !/^-?\d{1,20}$/.test(c)) throw new Error("Sohbet kimliği yalnızca rakam olmalı");
        values.telegram_chat = c;
      }
      if (body.notify_hours !== undefined) {
        const h = String(body.notify_hours).trim();
        const m = /^(\d{1,2})-(\d{1,2})$/.exec(h);
        if (!m || +m[1]! > 23 || +m[2]! > 24 || +m[1]! >= +m[2]!) throw new Error("Sessiz saat aralığı 9-22 biçiminde olmalı");
        values.notify_hours = h;
      }
      if (body.triggers !== undefined) {
        const list = String(body.triggers).split(",").map((t) => t.trim()).filter(Boolean);
        if (list.some((t) => !TRIGGERS.includes(t as Trigger))) throw new Error("Bilinmeyen bildirim türü");
        values.notify_triggers = list.join(",");
      }
      if (body.theme !== undefined) {
        const t = String(body.theme);
        if (!THEMES.includes(t as Theme)) throw new Error("Tema 'system', 'light' veya 'dark' olmalı");
        values.theme = t;
      }
      for (const k of NAME_LISTS) {
        const raw = body[`names_${k}`];
        if (raw === undefined) continue;
        // Satır başına bir ad. Boşluklar kırpılır, boşlar ve tekrarlar atılır.
        // Tamamen boşaltılırsa anahtar silinir ve varsayılan listeye dönülür.
        const list = [...new Set(String(raw).split("\n").map((n) => n.trim().slice(0, 120)).filter(Boolean))];
        if (list.length > 100) throw new Error("Bir listede en fazla 100 ad olabilir");
        if (list.some((n) => /[\u0000-\u001f]/.test(n))) throw new Error("Ad geçersiz karakter içeriyor");
        values[`names_${k as NameList}`] = list.join("\n");
      }
      saveSettings(values);
      return Response.json(readState());
    }

    if (resource === "notify" && method === "POST" && rawId === "test") {
      const r = await sendTest();
      return Response.json({ ...r, state: readState() }, { status: r.ok ? 200 : 400 });
    }

    if (resource === "notify" && method === "POST" && rawId === "forget") {
      const cleared = forgetSent();
      return Response.json({ ok: true, reason: `${cleared} kayıt sıfırlandı.`, state: readState() });
    }

    if (resource === "notify" && method === "GET" && rawId === "preview") {
      return Response.json(previewNotification(readState()));
    }

    if (resource === "payments" && method === "POST" && action === "undo") {
      undoPayment(idOf(rawId));
      return Response.json(readState());
    }

    if (resource === "records") {
      if (method === "POST" && !rawId) {
        const type = body.type === "debt" ? "debt" : body.type === "receivable" ? "receivable" : null;
        if (!type) throw new Error("Tip 'receivable' veya 'debt' olmalı");
        const amount = money(body.amount, "Tutar");
        db.run(
          "INSERT INTO personal_records (person, type, amount, remaining_amount, due_date) VALUES (?, ?, ?, ?, ?)",
          [text(body.person, "Kişi"), type, amount, amount, date(body.due_date)],
        );
        return Response.json(readState(), { status: 201 });
      }
      if (method === "PATCH" && rawId) {
        const id = idOf(rawId);
        const row = db.query<PersonalRecord, [number]>("SELECT * FROM personal_records WHERE id = ?").get(id);
        if (!row) throw new Error("Kayıt bulunamadı");
        const type = body.type === "debt" || body.type === "receivable" ? body.type : row.type;
        const amount = money(keep(body.amount, row.amount), "Tutar");
        // Ödenmiş kısım korunur; tutar düşürülürse kalan sıfırın altına inmez.
        const paid = row.amount - row.remaining_amount;
        db.run("UPDATE personal_records SET person = ?, type = ?, amount = ?, remaining_amount = ?, due_date = ? WHERE id = ?", [
          text(keep(body.person, row.person), "Kişi"),
          type,
          amount,
          Math.max(0, Math.round((amount - paid) * 100) / 100),
          date(keep(body.due_date, row.due_date)),
          id,
        ]);
        return Response.json(readState());
      }
      if (method === "POST" && action === "pay") {
        payRecord(idOf(rawId), money(body.amount, "Ödeme tutarı"));
        return Response.json(readState());
      }
      if (method === "DELETE" && rawId) {
        remove("personal_records", idOf(rawId));
        return Response.json(readState());
      }
    }

    if (resource === "cards") {
      if (method === "POST" && !rawId) {
        const statement = money0(body.statement_amount, "Dönem borcu");
        const minimum = money0(body.minimum_amount, "Asgari tutar");
        if (minimum > statement) throw new Error("Asgari tutar dönem borcundan büyük olamaz");
        db.run("INSERT INTO credit_cards (name, statement_amount, minimum_amount, due_date, min_ratio) VALUES (?, ?, ?, ?, ?)", [
          text(body.name, "Kart adı"),
          statement,
          minimum,
          date(body.due_date),
          ratioOf(statement, minimum),
        ]);
        return Response.json(readState(), { status: 201 });
      }
      if (method === "PATCH" && rawId) {
        const id = idOf(rawId);
        const row = db.query<CreditCard, [number]>("SELECT * FROM credit_cards WHERE id = ?").get(id);
        if (!row) throw new Error("Kart bulunamadı");
        const statement = money0(keep(body.statement_amount, row.statement_amount), "Dönem borcu");
        const minimum = money0(keep(body.minimum_amount, row.minimum_amount), "Asgari tutar");
        if (minimum > statement) throw new Error("Asgari tutar dönem borcundan büyük olamaz");
        db.run(
          "UPDATE credit_cards SET name = ?, statement_amount = ?, minimum_amount = ?, due_date = ?, min_ratio = coalesce(?, min_ratio) WHERE id = ?",
          [
            text(keep(body.name, row.name), "Kart adı"),
            statement,
            minimum,
            date(keep(body.due_date, row.due_date)),
            ratioOf(statement, minimum),
            id,
          ],
        );
        return Response.json(readState());
      }
      if (method === "POST" && action === "pay") {
        const mode = String(body.mode ?? "custom");
        payCard(idOf(rawId), mode, mode === "custom" ? money(body.amount, "Ödeme tutarı") : 0);
        return Response.json(readState());
      }
      // Kart her ay yenilenir: yeni dönem ekstresini mevcut kartın üzerine yaz.
      if (method === "POST" && action === "statement") {
        const statement = money0(body.statement_amount, "Dönem borcu");
        const minimum = money0(body.minimum_amount, "Asgari tutar");
        if (minimum > statement) throw new Error("Asgari tutar dönem borcundan büyük olamaz");
        const changed = db.run(
          "UPDATE credit_cards SET statement_amount = ?, minimum_amount = ?, due_date = ?, min_ratio = coalesce(?, min_ratio) WHERE id = ?",
          [statement, minimum, date(body.due_date), ratioOf(statement, minimum), idOf(rawId)],
        ).changes;
        if (!changed) throw new Error("Kart bulunamadı");
        return Response.json(readState());
      }
      if (method === "DELETE" && rawId) {
        remove("credit_cards", idOf(rawId));
        return Response.json(readState());
      }
    }

    if (resource === "loans") {
      if (method === "POST" && !rawId) {
        const total = count(body.total_installments, "Toplam taksit");
        const paid = Math.min(Number(body.paid_installments ?? 0) || 0, total);
        if (paid < 0) throw new Error("Ödenen taksit negatif olamaz");
        db.run(
          "INSERT INTO loans (name, installment_amount, total_installments, paid_installments, next_due_date) VALUES (?, ?, ?, ?, ?)",
          [text(body.name, "Kredi adı"), money(body.installment_amount, "Taksit tutarı"), total, paid, date(body.next_due_date)],
        );
        return Response.json(readState(), { status: 201 });
      }
      if (method === "PATCH" && rawId) {
        const id = idOf(rawId);
        const row = db.query<Loan, [number]>("SELECT * FROM loans WHERE id = ?").get(id);
        if (!row) throw new Error("Kredi bulunamadı");
        const total = count(keep(body.total_installments, row.total_installments), "Toplam taksit");
        const paid = Number(keep(body.paid_installments, row.paid_installments));
        if (!Number.isInteger(paid) || paid < 0) throw new Error("Ödenen taksit negatif olamaz");
        if (paid > total) throw new Error("Ödenen taksit toplamı aşamaz");
        db.run(
          "UPDATE loans SET name = ?, installment_amount = ?, total_installments = ?, paid_installments = ?, next_due_date = ? WHERE id = ?",
          [
            text(keep(body.name, row.name), "Kredi adı"),
            money(keep(body.installment_amount, row.installment_amount), "Taksit tutarı"),
            total,
            paid,
            date(keep(body.next_due_date, row.next_due_date)),
            id,
          ],
        );
        return Response.json(readState());
      }
      if (method === "POST" && action === "pay") {
        payLoan(idOf(rawId));
        return Response.json(readState());
      }
      if (method === "DELETE" && rawId) {
        remove("loans", idOf(rawId));
        return Response.json(readState());
      }
    }

    if (resource === "expenses") {
      if (method === "POST" && !rawId) {
        const due = date(body.next_due_date);
        if (!due) throw new Error("İlk ödeme tarihi zorunlu");
        const renews = date(body.renews_on);
        if (renews && renews < due) throw new Error("Yenilenme tarihi ilk ödemeden önce olamaz");
        db.run("INSERT INTO recurring_expenses (name, amount, next_due_date, renews_on) VALUES (?, ?, ?, ?)", [
          text(body.name, "Gider adı"),
          money(body.amount, "Tutar"),
          due,
          renews,
        ]);
        return Response.json(readState(), { status: 201 });
      }
      if (method === "PATCH" && rawId) {
        const id = idOf(rawId);
        const row = db.query<RecurringExpense, [number]>("SELECT * FROM recurring_expenses WHERE id = ?").get(id);
        if (!row) throw new Error("Gider bulunamadı");
        const due = date(keep(body.next_due_date, row.next_due_date));
        if (!due) throw new Error("Ödeme tarihi zorunlu");
        const renews = date(keep(body.renews_on, row.renews_on));
        if (renews && renews < due) throw new Error("Yenilenme tarihi ödeme tarihinden önce olamaz");
        db.run("UPDATE recurring_expenses SET name = ?, amount = ?, next_due_date = ?, renews_on = ? WHERE id = ?", [
          text(keep(body.name, row.name), "Gider adı"),
          money(keep(body.amount, row.amount), "Tutar"),
          due,
          renews,
          id,
        ]);
        return Response.json(readState());
      }
      if (method === "POST" && action === "pay") {
        payExpense(idOf(rawId));
        return Response.json(readState());
      }
      if (method === "DELETE" && rawId) {
        remove("recurring_expenses", idOf(rawId));
        return Response.json(readState());
      }
    }

    return Response.json({ error: "Bilinmeyen endpoint" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
