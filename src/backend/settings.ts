import { db, type PublicSettings } from "./db";

/** Anahtar/değer ayar deposu. Yeni ayar için şema değişikliği gerekmez. */
export const readSettings = (): Record<string, string> =>
  Object.fromEntries(
    db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]),
  );

export const saveSettings = (values: Record<string, string>) => {
  const put = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const del = db.prepare("DELETE FROM settings WHERE key = ?");
  db.transaction(() => {
    for (const [k, v] of Object.entries(values)) (v === "" ? del.run(k) : put.run(k, v));
  })();
};

/* Ad önerileri. Kullanıcı Ayarlar'dan değiştirebilir; boş bırakırsa bu listelere döner. */
export const NAME_LISTS = ["kart", "kredi", "gider"] as const;
export type NameList = (typeof NAME_LISTS)[number];

const DEFAULT_NAMES: Record<NameList, string[]> = {
  kart: ["Axess", "Advantage", "Bankkart", "Bonus", "CardFinans", "Maximum", "Miles&Smiles", "Paraf", "Wings", "World"],
  kredi: ["İhtiyaç kredisi", "Taşıt kredisi", "Konut kredisi", "Eğitim kredisi", "Kredili mevduat hesabı"],
  gider: ["Kira", "Aidat", "Elektrik", "Doğalgaz", "Su", "İnternet", "Telefon", "Netflix", "Spotify", "Spor salonu", "Sigorta", "Okul taksiti"],
};

/** Kaydedilmiş liste yoksa varsayılan döner. */
export function nameLists(s = readSettings()): Record<NameList, string[]> {
  return Object.fromEntries(
    NAME_LISTS.map((k) => {
      const saved = (s[`names_${k}`] ?? "").split("\n").map((n) => n.trim()).filter(Boolean);
      return [k, saved.length ? saved : DEFAULT_NAMES[k]];
    }),
  ) as Record<NameList, string[]>;
}

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Arayüze giden ayarlar — bot token'ı ASLA burada dönmez, sadece kurulu mu bilgisi. */
export function publicSettings(): PublicSettings {
  const s = readSettings();
  const token = s.telegram_token || process.env.TELEGRAM_BOT_TOKEN || "";
  const chat = s.telegram_chat || process.env.TELEGRAM_CHAT_ID || "";
  return {
    pinSet: !!s.pin_hash,
    telegramConfigured: !!(token && chat),
    telegramChat: chat,
    notifyHours: s.notify_hours || process.env.VADEO_NOTIFY_HOURS || "9-22",
    triggers: (s.notify_triggers ?? "daily,late,statement,renew").split(",").filter(Boolean),
    source: s.telegram_token ? "db" : process.env.TELEGRAM_BOT_TOKEN ? "env" : "none",
    theme: (THEMES as readonly string[]).includes(s.theme ?? "") ? (s.theme as Theme) : "system",
    names: nameLists(s),
  };
}
