/**
 * Telegram bildirimleri. Sistemde hiçbir şey kurmaz: cron, systemd, servis yok.
 * Zaten çalışan sunucunun içinden saatte bir tetiklenir (src/index.ts).
 * Elle:  bun run src/notify.ts --dry
 *
 * Ayarlar önce veritabanından (Ayarlar sayfası), yoksa .env'den okunur.
 */
import { db, type AppState } from "./backend/db";
import { readSettings } from "./backend/settings";
import { addDays, daysUntil, moneyExact, monthKey, today, trDate, upcoming } from "./shared";

export const TRIGGERS = ["daily", "late", "statement", "renew"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const TRIGGER_LABEL: Record<Trigger, string> = {
  daily: "Bugün ve yarın",
  late: "Gecikmiş",
  statement: "Ekstre bekleniyor",
  renew: "Sözleşme yenileniyor",
};

/* ------------------------------------------------------------------ */
/* Ayarlar                                                             */
/* ------------------------------------------------------------------ */

export function config() {
  const s = readSettings();
  const triggers = (s.notify_triggers ?? TRIGGERS.join(",")).split(",").filter((t) => TRIGGERS.includes(t as Trigger));
  return {
    token: s.telegram_token || process.env.TELEGRAM_BOT_TOKEN || "",
    chat: s.telegram_chat || process.env.TELEGRAM_CHAT_ID || "",
    hours: s.notify_hours || process.env.VADEO_NOTIFY_HOURS || "9-22",
    triggers: new Set(triggers as Trigger[]),
  };
}

/* ------------------------------------------------------------------ */
/* Olaylar                                                             */
/* ------------------------------------------------------------------ */

/** Telegram HTML modu: kullanıcı girdisi olan adlar kaçırılmadan gönderilmez. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface Event { key: string; trigger: Trigger; line: string; total?: number; }

/** Aksiyon gerektiren olayları toplar. Rutin durum bildirmez — sadece değişen şeyler. */
export function collect(state: AppState, enabled: Set<Trigger> = new Set(TRIGGERS)): Event[] {
  const events: Event[] = [];
  // Tek okuma: aynı çalıştırma içinde gece yarısı geçse bile hesap tutarlı kalsın.
  const asOf = today();
  const tomorrow = addDays(asOf, 1);
  const items = upcoming(state, 45).filter((u) => u.direction === "out");

  // 1) Bugün ve yarın — günde tek özet.
  if (enabled.has("daily")) {
    const dueNow = items.filter((u) => u.due >= asOf && u.due <= tomorrow);
    if (dueNow.length > 0) {
      events.push({
        key: `daily:${asOf}`,
        trigger: "daily",
        total: dueNow.reduce((a, u) => a + u.amount, 0),
        line: dueNow.map((u) => `• ${esc(u.title)} — ${moneyExact(u.amount)} (${u.due === asOf ? "bugün" : "yarın"})`).join("\n"),
      });
    }
  }

  // 2) Gecikme — kalem başına bir kez. Vade değişip yeniden geçerse tekrar haber verir.
  if (enabled.has("late")) {
    for (const u of items.filter((u) => u.due < asOf)) {
      events.push({
        key: `late:${u.kind}:${u.id}:${u.due}`,
        trigger: "late",
        line: `• ${esc(u.title)} — ${moneyExact(u.amount)} (${-daysUntil(u.due)} gün geçti)`,
      });
    }
  }

  // 3) Ekstresi girilmemiş kart: borç sıfır ama son ödeme tarihi geçmiş.
  //    Aydaki tek manuel iş bu; unutulursa projeksiyon sessizce yanlışa döner.
  if (enabled.has("statement")) {
    for (const c of state.cards) {
      if (c.statement_amount === 0 && c.due_date && c.due_date < asOf) {
        events.push({
          key: `statement:${c.id}:${monthKey(asOf)}`,
          trigger: "statement",
          line: `• ${esc(c.name)} — son ödeme ${trDate(c.due_date)} geçti, yeni dönem girilmemiş`,
        });
      }
    }
  }

  // 4) Sözleşme yenilenmesi — pazarlık veya iptal için 30 gün önceden.
  if (enabled.has("renew")) {
    for (const e of state.expenses) {
      if (!e.renews_on) continue;
      const left = daysUntil(e.renews_on);
      if (left >= 0 && left <= 30) {
        events.push({
          key: `renew:${e.id}:${e.renews_on}`,
          trigger: "renew",
          line: `• ${esc(e.name)} — ${trDate(e.renews_on)} (${left === 0 ? "bugün" : `${left} gün`})`,
        });
      }
    }
  }

  return events;
}

export const unsent = (events: Event[]) =>
  events.filter((e) => !db.query<{ key: string }, [string]>("SELECT key FROM sent_notifications WHERE key = ?").get(e.key));

export const markSent = (events: Event[]) => {
  const stmt = db.prepare("INSERT OR IGNORE INTO sent_notifications (key) VALUES (?)");
  db.transaction(() => events.forEach((e) => stmt.run(e.key)))();
};

export const forgetSent = () => db.run("DELETE FROM sent_notifications").changes;

export function compose(events: Event[]): string {
  // İlk satır kilit ekranında görünen tek şey: tutar orada olmalı.
  const daily = events.find((e) => e.trigger === "daily");
  const head = daily
    ? `Bugün ve yarın ${moneyExact(daily.total ?? 0)} ödemen var.`
    : `Vadeo — ${events.length} hatırlatma`;
  const body = TRIGGERS.filter((t) => events.some((e) => e.trigger === t))
    .map((t) => `<b>${TRIGGER_LABEL[t]}</b>\n${events.filter((e) => e.trigger === t).map((e) => e.line).join("\n")}`)
    .join("\n\n");
  return `${head}\n\n${body}`;
}

/* ------------------------------------------------------------------ */
/* Gönderim                                                            */
/* ------------------------------------------------------------------ */

/** Sessiz saatler: aralık dışındaysa gönderme, olayı da işaretleme — sonra tekrar dener. */
export function awake(hours: string, now = new Date()) {
  const [from, to] = hours.split("-").map(Number);
  const h = now.getHours();
  return h >= (from ?? 9) && h < (to ?? 22);
}

export async function send(token: string, chat: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (res.ok) return { ok: true as const, reason: "gönderildi" };
  const body = await res.text().catch(() => "");
  // Telegram'ın kendi açıklaması hatanın ne olduğunu söylüyor; olduğu gibi göster.
  const detail = (() => { try { return JSON.parse(body).description as string; } catch { return body.slice(0, 200); } })();
  return { ok: false as const, reason: `Telegram ${res.status}: ${detail}` };
}

export async function notify(state: AppState, { dry = false } = {}) {
  const c = config();
  if (!dry && (!c.token || !c.chat)) return { sent: 0, reason: "yapılandırılmamış" };
  if (!dry && !awake(c.hours)) return { sent: 0, reason: "sessiz saat" };

  const events = unsent(collect(state, c.triggers));
  if (events.length === 0) return { sent: 0, reason: "yeni olay yok" };

  const text = compose(events);
  if (dry) {
    console.log(text.replace(/<\/?b>/g, ""));
    return { sent: events.length, reason: "kuru çalıştırma" };
  }
  const r = await send(c.token, c.chat, text);
  if (!r.ok) return { sent: 0, reason: r.reason };
  markSent(events);
  return { sent: events.length, reason: "gönderildi" };
}

/** Ayarlar sayfasındaki "Test gönder" — kuyruğa ve sessiz saate bakmaz. */
export async function sendTest() {
  const c = config();
  if (!c.token || !c.chat) return { ok: false, reason: "Önce bot token ve sohbet kimliğini kaydet." };
  const r = await send(c.token, c.chat, "<b>Vadeo</b>\nBildirimler çalışıyor.");
  return { ok: r.ok, reason: r.ok ? "Test mesajı gönderildi." : r.reason };
}

/** Ayarlar sayfası: gönderilmeden, kuyruğa dokunulmadan ne gideceğini gösterir. */
export function previewNotification(state: AppState) {
  const c = config();
  const events = unsent(collect(state, c.triggers));
  return {
    configured: !!(c.token && c.chat),
    count: events.length,
    text: events.length ? compose(events).replace(/<\/?b>/g, "") : "",
  };
}

if (import.meta.main) {
  const { readState } = await import("./backend/routes"); // döngüsel import olmasın diye burada
  const r = await notify(readState(), { dry: process.argv.includes("--dry") });
  console.log(`[vadeo] ${r.sent} olay — ${r.reason}`);
}
