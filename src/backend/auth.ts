import { db } from "./db";
import { readSettings, saveSettings } from "./settings";

/**
 * PIN ile erişim koruması.
 *
 * Bir PIN'in entropisi düşük (4 hane = 10.000 ihtimal), bu yüzden yavaş hash
 * TEK BAŞINA yetmez: argon2id ~100ms olsa bile tüm uzay ~17 dakikada taranır.
 * Asıl koruma artan bekleme süresidir — 5. hatadan sonra süre her denemede ikiye
 * katlanır ve tarama pratikte imkânsız hale gelir.
 */

const COOKIE = "vadeo_session";
const SESSION_DAYS = 30;
const FREE_TRIES = 5;
const MAX_LOCK_MIN = 60;

export const isPinSet = () => !!readSettings().pin_hash;

/** Bekleme bitiş anı; kilit yoksa null. */
export function lockedUntil(): Date | null {
  const raw = readSettings().pin_locked_until;
  if (!raw) return null;
  const until = new Date(raw);
  return until.getTime() > Date.now() ? until : null;
}

const lockMinutes = (fails: number) =>
  fails < FREE_TRIES ? 0 : Math.min(2 ** (fails - FREE_TRIES), MAX_LOCK_MIN);

export function validPinFormat(pin: string) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN 4-8 rakam olmalı");
  return pin;
}

export async function verifyPin(pin: string): Promise<{ ok: boolean; waitSeconds?: number }> {
  const until = lockedUntil();
  if (until) return { ok: false, waitSeconds: Math.ceil((until.getTime() - Date.now()) / 1000) };

  const hash = readSettings().pin_hash;
  if (!hash) return { ok: true }; // PIN kurulu değil: koruma kapalı

  if (await Bun.password.verify(pin, hash)) {
    saveSettings({ pin_fails: "", pin_locked_until: "" });
    return { ok: true };
  }

  const fails = Number(readSettings().pin_fails ?? 0) + 1;
  const minutes = lockMinutes(fails);
  saveSettings({
    pin_fails: String(fails),
    pin_locked_until: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : "",
  });
  return { ok: false, waitSeconds: minutes * 60 || undefined };
}

/** PIN kurar veya değiştirir. Kurulu bir PIN varsa mevcut PIN şart. */
export async function setPin(next: string, current: string | undefined) {
  if (isPinSet()) {
    const r = await verifyPin(String(current ?? ""));
    if (!r.ok) throw new Error(r.waitSeconds ? `Çok fazla hatalı deneme. ${r.waitSeconds} sn bekle.` : "Mevcut PIN yanlış");
  }
  saveSettings({ pin_hash: await Bun.password.hash(validPinFormat(next)), pin_fails: "", pin_locked_until: "" });
  dropSessions(); // PIN değişince tüm cihazlar yeniden sorulur
}

export async function clearPin(current: string) {
  if (!isPinSet()) return;
  const r = await verifyPin(current);
  if (!r.ok) throw new Error(r.waitSeconds ? `Çok fazla hatalı deneme. ${r.waitSeconds} sn bekle.` : "PIN yanlış");
  saveSettings({ pin_hash: "", pin_fails: "", pin_locked_until: "" });
  dropSessions();
}

/* ------------------------------------------------------------------ */
/* Oturum                                                              */
/* ------------------------------------------------------------------ */

const token = () =>
  [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function createSession() {
  db.run("DELETE FROM sessions WHERE expires_at < datetime('now','localtime')");
  const t = token();
  db.run("INSERT INTO sessions (token, expires_at) VALUES (?, datetime('now','localtime', ?))", [t, `+${SESSION_DAYS} days`]);
  return t;
}

export const dropSessions = () => db.run("DELETE FROM sessions");
export const dropSession = (t: string) => db.run("DELETE FROM sessions WHERE token = ?", [t]);

const cookieOf = (req: Request) =>
  req.headers.get("cookie")?.split(";").map((c) => c.trim().split("=")).find(([k]) => k === COOKIE)?.[1] ?? "";

/** İstek yetkili mi? PIN kurulu değilse koruma yok. */
export function authorized(req: Request) {
  if (!isPinSet()) return true;
  const t = cookieOf(req);
  if (!t) return false;
  return !!db.query<{ token: string }, [string]>(
    "SELECT token FROM sessions WHERE token = ? AND expires_at > datetime('now','localtime')",
  ).get(t);
}

export const sessionCookie = (t: string) =>
  // Secure yok: ev ağında düz HTTP üzerinden çalışıyor. TLS eklenirse buraya Secure gelmeli.
  `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
export { cookieOf };
