import { Database } from "bun:sqlite";

// ponytail: para REAL olarak tutuluyor, her yazımda 2 haneye yuvarlanıyor.
// Kişisel takip ölçeğinde yeterli; kuruş hassasiyeti dert olursa INTEGER kuruşa geçir.
export const db = new Database(process.env.VADEO_DB ?? "db.sqlite", { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS personal_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  person           TEXT    NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN ('receivable', 'debt')),
  amount           REAL    NOT NULL CHECK (amount > 0),
  remaining_amount REAL    NOT NULL CHECK (remaining_amount >= 0),
  due_date         TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credit_cards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  statement_amount REAL    NOT NULL CHECK (statement_amount >= 0),
  minimum_amount   REAL    NOT NULL CHECK (minimum_amount >= 0),
  due_date         TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  installment_amount REAL    NOT NULL CHECK (installment_amount > 0),
  total_installments INTEGER NOT NULL CHECK (total_installments > 0),
  paid_installments  INTEGER NOT NULL DEFAULT 0 CHECK (paid_installments >= 0),
  next_due_date      TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (paid_installments <= total_installments)
);

-- Sabit giderler süresiz değildir: kira yenilenir, abonelik biter.
-- renews_on = sözleşmenin bittiği/yenilendiği tarih; projeksiyon oradan sonrasını uydurmaz.
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  amount        REAL    NOT NULL CHECK (amount > 0),
  next_due_date TEXT    NOT NULL,
  renews_on     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_table  TEXT    NOT NULL,
  ref_id     INTEGER NOT NULL,
  amount     REAL    NOT NULL,
  note       TEXT,
  paid_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_logs_ref ON payment_logs (ref_table, ref_id);

-- Uygulama ayarları. Anahtar/değer: yeni ayar için şema değişikliği gerekmesin.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Oturumlar. Yedeğe DAHİL DEĞİL: eski yedek eski oturumları diriltmemeli ve
-- yedek dosyası oturum anahtarı taşımamalı.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);

-- Gönderilmiş bildirimler. Aynı olay iki kez haber verilmesin diye anahtarla işaretlenir.
CREATE TABLE IF NOT EXISTS sent_notifications (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// payment_logs.prev — ödemenin bozduğu alanların önceki değerleri; geri alma bunu geri yazar.
// Mevcut veritabanları için tek seferlik ekleme.
if (!db.query<{ name: string }, []>("PRAGMA table_info(payment_logs)").all().some((c) => c.name === "prev")) {
  db.exec("ALTER TABLE payment_logs ADD COLUMN prev TEXT");
}

// credit_cards.min_ratio — kartın kendi asgari oranı. Her ay elle hesaplamak yerine
// son girilen ekstreden öğrenilir ve bir sonraki ekstrede önden doldurulur.
if (!db.query<{ name: string }, []>("PRAGMA table_info(credit_cards)").all().some((c) => c.name === "min_ratio")) {
  db.exec("ALTER TABLE credit_cards ADD COLUMN min_ratio REAL");
}

export type RecordType = "receivable" | "debt";

export interface PersonalRecord {
  id: number;
  person: string;
  type: RecordType;
  amount: number;
  remaining_amount: number;
  due_date: string | null;
  created_at: string;
}

export interface CreditCard {
  id: number;
  name: string;
  statement_amount: number;
  minimum_amount: number;
  min_ratio: number | null;
  due_date: string | null;
  created_at: string;
}

export interface Loan {
  id: number;
  name: string;
  installment_amount: number;
  total_installments: number;
  paid_installments: number;
  next_due_date: string | null;
  created_at: string;
}

export interface RecurringExpense {
  id: number;
  name: string;
  amount: number;
  next_due_date: string;
  renews_on: string | null;
  created_at: string;
}

export interface PaymentLog {
  id: number;
  ref_table: string;
  ref_id: number;
  amount: number;
  note: string | null;
  paid_at: string;
  prev: string | null;
}

export interface Summary {
  totalReceivable: number;
  totalPersonalDebt: number;
  totalCardDebt: number;
  totalLoanPrincipal: number;
}

/** Arayüze giden ayarlar — bot token'ı ASLA burada dönmez, sadece kurulu mu bilgisi. */
export interface PublicSettings {
  pinSet: boolean;
  telegramConfigured: boolean;
  telegramChat: string;
  notifyHours: string;
  triggers: string[];
  source: "db" | "env" | "none";
  theme: "system" | "light" | "dark";
  names: Record<"kart" | "kredi" | "gider", string[]>;
}

/** Yedek/geri yükleme kapsamı. Sıra önemli: geri yüklerken de bu sırayla yazılır. */
export const DATA_TABLES = [
  "personal_records", "credit_cards", "loans", "recurring_expenses", "payment_logs", "settings", "sent_notifications",
] as const;

export interface DataStats {
  records: number;
  cards: number;
  loans: number;
  expenses: number;
  logs: number;
  bytes: number;
  since: string | null;
}

export interface AppState {
  summary: Summary;
  records: PersonalRecord[];
  cards: CreditCard[];
  loans: Loan[];
  expenses: RecurringExpense[];
  logs: PaymentLog[];
  settings: PublicSettings;
  stats: DataStats;
}
