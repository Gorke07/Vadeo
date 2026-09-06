import { useEffect, useMemo, useState } from "react";
import { areaY, barY, colorLegend, defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { group } from "@tanstack/charts/group";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import type { AppState, CreditCard, Loan, PersonalRecord, RecurringExpense } from "../backend/db";
import {
  countdown, daysUntil, forecast, money, moneyExact, monthKey, monthLabel, monthPlan,
  longDate, nextMonthDate, occurrences, paidByMonth, payoff, today, trDate, upcoming,
  type Kind, type PlanRow, type Upcoming,
} from "../shared";

/* ------------------------------------------------------------------ */
/* Yönlendirme — History API, kütüphane yok                            */
/* ------------------------------------------------------------------ */

const ROUTES = [
  { path: "/", label: "Özet", title: "Özet", kind: null },
  { path: "/kisiler", label: "Kişiler", title: "Kişiler", kind: "record" },
  { path: "/kartlar", label: "Kartlar", title: "Kredi kartları", kind: "card" },
  { path: "/krediler", label: "Krediler", title: "Krediler", kind: "loan" },
  { path: "/giderler", label: "Sabit giderler", title: "Sabit giderler", kind: "expense" },
  { path: "/ay", label: "Bu ay", title: "Ödeme listesi", kind: null },
  { path: "/hareketler", label: "Geçmiş", title: "Ödeme geçmişi", kind: null },
  { path: "/ayarlar", label: "Ayarlar", title: "Ayarlar", kind: null },
] as const;

const TRIGGERS: [string, string, string][] = [
  ["daily", "Bugün ve yarın", "Sabah tek özet; vadesi bugün veya yarın olanlar."],
  ["late", "Gecikmiş", "Bir kalem ilk kez vadeyi geçtiğinde, tek sefer."],
  ["statement", "Ekstre bekleniyor", "Kartın borcu sıfır ama son ödeme tarihi geçmişse."],
  ["renew", "Sözleşme yenileniyor", "Kira/abonelik bitişine 30 gün kala."],
];

const PATH_OF: Record<Kind, string> = {
  record: "/kisiler", card: "/kartlar", loan: "/krediler", expense: "/giderler",
};

function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const pop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const go = (to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  };
  return [ROUTES.some((r) => r.path === path) ? path : "/", go] as const;
}

/* ------------------------------------------------------------------ */
/* Parçalar                                                            */
/* ------------------------------------------------------------------ */

// Eksen ve ızgara renkleri CSS değişkenlerinden; koyu/açık mod kendiliğinden çalışır.
const THEME = {
  foreground: "var(--fg)",
  muted: "var(--dim)",
  grid: "var(--rule)",
  background: "transparent",
} as const;

const kisaTL = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(".", ",")}M` : n >= 1000 ? `${Math.round(n / 1000)}B` : String(n);

/**
 * Varsayılan ipucu kanal adlarını ("x", "y") ve ham sayıyı gösteriyor; Türkçeleştir.
 * Uzun ay adı verinin içinde taşınıyor — kısa etiketten yıla geri çözmek belirsiz
 * ("Kas" 12 aylık pencerede iki yıla da denk gelebilir).
 */
const ipucu = {
  use: tooltip,
  content: (points: readonly { datum: { baslik: string; seri?: string; deger: number } }[]) => ({
    title: points[0]?.datum.baslik ?? "",
    rows: points.map((p) => ({ label: p.datum.seri ?? "tutar", value: moneyExact(p.datum.deger) })),
  }),
};

/** 12 aylık nakit projeksiyonu — iki seri, gruplanmış çubuk. */
function Runway({ state }: { state: AppState }) {
  const rows = useMemo(
    () =>
      forecast(state).flatMap((b) => {
        const baslik = monthLabel(b.key, { month: "long", year: "numeric" });
        return [
          { ay: monthLabel(b.key), baslik, seri: "ödenecek", deger: b.out },
          { ay: monthLabel(b.key), baslik, seri: "tahsil edilecek", deger: b.in },
        ];
      }),
    [state],
  );
  const max = Math.max(...rows.map((r) => r.deger), 0);

  const definition = useMemo(
    () =>
      defineChart({
        marks: [barY(rows, { x: "ay", y: "deger", z: "seri", color: "seri", layout: group({ padding: 0.15 }), radius: 2 })],
        scales: {
          x: { scale: () => scaleBand<string>().padding(0.3) },
          y: { scale: scaleLinear, nice: true, grid: true, axis: { ticks: { format: kisaTL, count: 4 } } },
        },
        color: {
          scale: () => scaleOrdinal<string, string>().range(["var(--mark-due)", "var(--mark-in)"]),
          legend: colorLegend({}),
        },
        theme: THEME,
        tooltip: ipucu,
      }),
    [rows],
  );

  if (max === 0) return <p className="blank">Kayıtlara vade tarihi girdiğinde önümüzdeki 12 ayın yükü burada belirir.</p>;

  return (
    <div className="chart">
      <p className="peak">Önümüzdeki 12 ayın nakit yükü</p>
      <Chart definition={definition} height={190} ariaLabel="Aylara göre ödenecek ve tahsil edilecek tutarlar" />
    </div>
  );
}

/**
 * Borç erime eğrisi. Tek seri olduğu için gösterge kutusu yok — başlık seriyi adlandırıyor.
 * Alan + üstünde çizgi: sıfıra inen bir stok en iyi böyle okunuyor.
 */
function Payoff({ state }: { state: AppState }) {
  const rows = useMemo(
    () =>
      payoff(state, 12).map((p, i) => ({
        ay: p.label,
        baslik: i === 0 ? "Bugün" : monthLabel(p.key, { month: "long", year: "numeric" }),
        deger: p.total,
      })),
    [state],
  );
  const max = Math.max(...rows.map((r) => r.deger), 0);

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          areaY(rows, { x: "ay", y: "deger", fill: "var(--mark-due)", fillOpacity: 0.16 }),
          lineY(rows, { x: "ay", y: "deger", stroke: "var(--mark-due)", strokeWidth: 2 }),
        ],
        scales: {
          x: { scale: () => scalePoint<string>().padding(0.04) },
          y: { scale: scaleLinear, nice: true, grid: true, axis: { ticks: { format: kisaTL, count: 4 } } },
        },
        theme: THEME,
        tooltip: ipucu,
      }),
    [rows],
  );

  if (max === 0) return null;
  const son = rows.at(-1)!;

  return (
    <div className="chart">
      <p className="peak">
        Kalan borç — 12 ay sonra <b className="num">{money(son.deger)}</b>
        {son.deger === 0 && <> · bu tempoda <b className="num">borç kapanıyor</b></>}
      </p>
      <Chart definition={definition} height={170} ariaLabel="Aylara göre kalan borç" />
    </div>
  );
}

/** Aya göre gerçekleşen ödemeler — tek seri çubuk. */
function PaidHistory({ rows }: { rows: { key: string; label: string; total: number }[] }) {
  const data = useMemo(
    () => rows.map((m) => ({ ay: m.label, baslik: monthLabel(m.key, { month: "long", year: "numeric" }), deger: m.total })),
    [rows],
  );
  const definition = useMemo(
    () =>
      defineChart({
        marks: [barY(data, { x: "ay", y: "deger", fill: "var(--mark-in)", radius: 2 })],
        scales: {
          x: { scale: () => scaleBand<string>().padding(0.4) },
          y: { scale: scaleLinear, nice: true, grid: true, axis: { ticks: { format: kisaTL, count: 4 } } },
        },
        theme: THEME,
        tooltip: ipucu,
      }),
    [data],
  );
  return (
    <div className="chart">
      <p className="peak">Aya göre yapılan ödemeler</p>
      <Chart definition={definition} height={170} ariaLabel="Aylara göre yapılan ödeme toplamları" />
    </div>
  );
}

function Entry(props: {
  when: ReturnType<typeof countdown>;
  title: React.ReactNode;
  note: React.ReactNode;
  amount: number;
  tone: string;
  suffix?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { when, title, note, amount, tone, suffix, extra, children } = props;
  return (
    <div className="entry">
      <div className={`when ${when.tone}`}>
        <b className="num">{when.head}</b>
        {when.tail}
      </div>
      <div className="what">
        <b>{title}</b>
        <p>{note}</p>
        {extra}
      </div>
      <div className={`amount num ${tone}`}>
        {moneyExact(amount)}
        {suffix && <span className="per">{suffix}</span>}
      </div>
      <div className="acts">{children}</div>
    </div>
  );
}

interface Field {
  name: string;
  label: string;
  list?: string;
  type?: string;
  value?: string | number | null;
  step?: string;
  min?: string;
  options?: [string, string][];
}

/** Satır içi form — hem düzenleme hem yeni ekstre/dönem için. */
function InlineForm({ fields, onSubmit, busy, submit, onInput }: {
  fields: Field[];
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  submit: string;
  /** Bir alan değişince diğerlerini türetmek için (ör. dönem borcundan asgariyi). */
  onInput?: (form: HTMLFormElement, changed: string) => void;
}) {
  return (
    <form className="restate" onSubmit={onSubmit}
      onInput={(e) => onInput?.(e.currentTarget, (e.target as HTMLInputElement).name)}>
      {fields.map((f, i) => (
        <label key={f.name}>
          {f.label}
          {f.options ? (
            <select name={f.name} defaultValue={String(f.value ?? "")}>
              {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ) : (
            <input name={f.name} type={f.type ?? "text"} step={f.step} min={f.min} list={f.list}
              autoFocus={i === 0} defaultValue={f.value ?? ""} />
          )}
        </label>
      ))}
      <button className="go" disabled={busy}>{submit}</button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Uygulama                                                            */
/* ------------------------------------------------------------------ */

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [month, setMonth] = useState(() => monthKey(today()));
  const [path, go] = useRoute();

  // Her yazma isteği güncel state'i döndürüyor; ayrı bir refetch yok.
  async function send(url: string, init?: RequestInit) {
    setBusy(true);
    try {
      const res = await fetch(url, init);
      const data = await res.json();
      if (res.status === 401) {
        // PIN korumalı ve oturum yok/düşmüş: kilit ekranına dön.
        setState(null);
        setLocked(true);
        setError(url === "/api/auth" ? (data.error ?? "PIN yanlış") : "");
        return false;
      }
      if (!res.ok) return setError(data.error ?? data.reason ?? "Bilinmeyen hata"), setNote(""), false;
      // Bazı uç noktalar state'i sarmalayarak döner (test gönderimi gibi).
      setState(data.state ?? data);
      setLocked(false);
      setError("");
      return true;
    } catch {
      return setError("Sunucuya ulaşılamadı."), false;
    } finally {
      setBusy(false);
    }
  }

  const write = (url: string, body: unknown, method = "POST") =>
    send(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const post = (url: string, body: unknown) => write(url, body);
  const drop = (url: string, label: string) =>
    confirm(`${label} kaydı silinsin mi?`) && send(url, { method: "DELETE" });

  const submit = (url: string, method = "POST") => async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (await write(url, Object.fromEntries(new FormData(form)), method)) {
      form.reset();
      form.closest("details")?.removeAttribute("open");
      setPanel(null);
    }
  };

  const toggle = (key: string) => setPanel(panel === key ? null : key);
  const editLabel = (key: string) => (panel === key ? "Vazgeç" : "Düzenle");
  const askAmount = (url: string, max: number) => {
    const raw = prompt(`Ne kadar ödendi? Kalan ${moneyExact(max)}.`, String(max));
    if (raw) post(url, { amount: raw });
  };

  useEffect(() => { send("/api/state"); }, []);

  // Seçilen tema kök elemana yazılır; "system" hiçbir şey yazmaz, CSS medya sorgusu devralır.
  const theme = state?.settings.theme ?? "system";
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Sekme gece yarısını aşarak açık kalırsa geri sayımlar bir gün bayatlar.
  // Odağa dönüldüğünde tarih değiştiyse sayfayı tazele.
  useEffect(() => {
    const opened = today();
    const check = () => { if (today() !== opened) window.location.reload(); };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  // Rayda ve sekme başlığında gösterilen sayı: gecikmiş + 7 gün içinde vadesi gelen.
  const week = state ? upcoming(state, 7) : [];

  // Başlık rotayı izler: sekme şeridinde, geçmişte ve yer imlerinde hangi sayfa
  // olduğu ayırt edilebilsin. Ayırt edici parça başta — sekme daralınca sonu kırpılır.
  const pageTitle = ROUTES.find((r) => r.path === path)?.title ?? "Özet";
  useEffect(() => {
    document.title = `${week.length > 0 ? `(${week.length}) ` : ""}${pageTitle} · Vadeo`;
  }, [pageTitle, week.length]);

  if (locked) {
    return (
      <div className="shell">
        <aside className="rail"><span className="mark">Vadeo</span></aside>
        <main className="view">
          <form className="lock" onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget;
            post("/api/auth", { pin: new FormData(f).get("pin") }).then((ok) => { if (!ok) f.reset(); });
          }}>
            <label>
              PIN
              <input name="pin" type="password" inputMode="numeric" autoComplete="current-password"
                pattern="\d*" maxLength={8} required autoFocus />
            </label>
            <button className="go" disabled={busy}>Aç</button>
            {error && <p className="alert">{error}</p>}
          </form>
        </main>
      </div>
    );
  }

  // Veri gelmeden önce: yükleniyorsa sessiz, ulaşılamıyorsa sebebi yazan bir kabuk.
  // Boş sayfa göstermek çevrimdışında (ve sunucu kapalıyken) tek bilgi kaynağını yok eder.
  if (!state) {
    return (
      <div className="shell">
        <aside className="rail"><span className="mark">Vadeo</span></aside>
        <main className="view">
          {error && (
            <div className="boot">
              <p className="alert">{error}</p>
              <p className="hint">
                Kayıtların sunucuda duruyor; bağlantı kurulunca olduğu gibi geri gelir.
              </p>
              <button className="go" disabled={busy} onClick={() => send("/api/state")}>Yeniden dene</button>
            </div>
          )}
        </main>
      </div>
    );
  }

  const { summary, records, cards, loans, expenses, logs } = state;
  const net = summary.totalReceivable - (summary.totalPersonalDebt + summary.totalCardDebt + summary.totalLoanPrincipal);
  const soonList = upcoming(state, 30);
  const soonOut = soonList.filter((u) => u.direction === "out");
  const soonTotal = soonOut.reduce((a, b) => a + b.amount, 0);
  const soonLate = soonOut.filter((u) => u.due < today()).reduce((a, b) => a + b.amount, 0);

  const urgentOf = (kind: Kind | null) => (kind ? week.filter((u) => u.kind === kind).length : 0);
  const countOf: Record<string, number> = {
    "/kisiler": records.length, "/kartlar": cards.length,
    "/krediler": loans.length, "/giderler": expenses.length, "/hareketler": logs.length,
  };

  /* ---------------- Özet ---------------- */

  const dashboard = (
    <>
      <div className="hero">
        <p>Net durum</p>
        <strong className="net">{money(net)}</strong>
        <p className="caption">
          {soonTotal > 0 ? (
            <>
              Önümüzdeki 30 günde <b className="num">{money(soonTotal)}</b> ödemen var
              {soonLate > 0 && <>, <b className="late num">{money(soonLate)}</b> kadarı gecikmiş</>}.
            </>
          ) : ("Önümüzdeki 30 günde vadesi gelen bir ödemen yok.")}
        </p>

        <ul className="parts">
          <li className="in"><b>{money(summary.totalReceivable)}</b><span>tahsil edilecek</span></li>
          <li className="due"><b>{money(summary.totalPersonalDebt)}</b><span>kişilere borç</span></li>
          <li className="due"><b>{money(summary.totalCardDebt)}</b><span>kart borcu</span></li>
          <li className="due"><b>{money(summary.totalLoanPrincipal)}</b><span>kredi kalan anapara</span></li>
        </ul>

        <Runway state={state} />
        <Payoff state={state} />
      </div>

      <section>
        <h2>Sıradaki 30 gün</h2>
        <div className="entries">
          {soonList.length === 0 && <p className="blank">Bu ay vadesi gelen bir şey yok.</p>}
          {soonList.map((u: Upcoming, i) => {
            const when = countdown(u.due, false);
            return (
              <Entry
                key={`${u.kind}${u.id}-${i}`}
                when={when}
                title={<button className="link" onClick={() => go(PATH_OF[u.kind])}>{u.title}</button>}
                note={<>{u.detail} · {trDate(u.due)}</>}
                amount={u.amount}
                tone={when.tone === "late" ? "late" : u.direction === "in" ? "in" : "due"}
              >
                {u.kind === "record" && (
                  <button className={u.direction === "in" ? "get" : "go"} disabled={busy}
                    onClick={() => post(`/api/records/${u.id}/pay`, { amount: u.amount })}>
                    {u.direction === "in" ? "Tahsil et" : "Öde"}
                  </button>
                )}
                {u.kind === "card" && (
                  <>
                    <button disabled={busy} onClick={() => post(`/api/cards/${u.id}/pay`, { mode: "min" })}>Asgariyi öde</button>
                    <button className="go" disabled={busy} onClick={() => post(`/api/cards/${u.id}/pay`, { mode: "full" })}>Borcu kapat</button>
                  </>
                )}
                {u.kind === "loan" && (
                  <button className="go" disabled={busy} onClick={() => post(`/api/loans/${u.id}/pay`, {})}>Taksiti öde</button>
                )}
                {u.kind === "expense" && (
                  <button className="go" disabled={busy} onClick={() => post(`/api/expenses/${u.id}/pay`, {})}>Bu ayı öde</button>
                )}
              </Entry>
            );
          })}
        </div>
      </section>
    </>
  );

  /* ---------------- Kişiler ---------------- */

  const people = (
    <section>
      <h2>Kişiler</h2>
      <div className="entries">
        {records.length === 0 && <p className="blank">Henüz kimse yok. İlk alacağını veya borcunu ekle.</p>}
        {records.map((r: PersonalRecord) => {
          const settled = r.remaining_amount === 0;
          const when = countdown(r.due_date, settled);
          const receivable = r.type === "receivable";
          return (
            <Entry key={r.id} when={when} title={r.person}
              note={<>
                {receivable ? "sana borçlu" : "ona borçlusun"}
                {r.remaining_amount < r.amount && !settled && <> · {moneyExact(r.amount - r.remaining_amount)} ödendi</>}
                {r.due_date && <> · vade {trDate(r.due_date)}</>}
              </>}
              amount={r.remaining_amount}
              tone={settled ? "settled" : when.tone === "late" ? "late" : receivable ? "in" : "due"}
            >
              <button disabled={busy || settled} onClick={() => askAmount(`/api/records/${r.id}/pay`, r.remaining_amount)}>Kısmi</button>
              <button className={receivable ? "get" : "go"} disabled={busy || settled}
                onClick={() => post(`/api/records/${r.id}/pay`, { amount: r.remaining_amount })}>
                {receivable ? "Tamamını tahsil et" : "Tamamını öde"}
              </button>
              <button onClick={() => toggle(`record:${r.id}`)}>{editLabel(`record:${r.id}`)}</button>
              <button className="drop" disabled={busy} onClick={() => drop(`/api/records/${r.id}`, r.person)}>Sil</button>
              {panel === `record:${r.id}` && (
                <InlineForm busy={busy} submit="Kaydet" onSubmit={submit(`/api/records/${r.id}`, "PATCH")}
                  fields={[
                    { name: "person", label: "Kim", value: r.person },
                    { name: "type", label: "Yön", value: r.type, options: [["receivable", "Bana borçlu"], ["debt", "Ona borçluyum"]] },
                    { name: "amount", label: "Tutar", type: "number", step: "0.01", min: "0.01", value: r.amount },
                    { name: "due_date", label: "Vade", type: "date", value: r.due_date },
                  ]} />
              )}
            </Entry>
          );
        })}
      </div>
      <details>
        <summary>Kişi ekle</summary>
        <form onSubmit={submit("/api/records")}>
          <label>Kim<input name="person" required maxLength={120} placeholder="Ahmet" /></label>
          <label>Yön
            <select name="type" defaultValue="receivable">
              <option value="receivable">Bana borçlu</option>
              <option value="debt">Ona borçluyum</option>
            </select>
          </label>
          <label>Tutar<input name="amount" type="number" step="0.01" min="0.01" required placeholder="1500" /></label>
          <label>Vade<input name="due_date" type="date" /></label>
          <button className="go" disabled={busy}>Kaydet</button>
        </form>
      </details>
    </section>
  );

  /* ---------------- Kartlar ---------------- */

  const cardsView = (
    <section>
      <h2>Kredi kartları</h2>
      <div className="entries">
        {cards.length === 0 && <p className="blank">Kart yok. Ekstresi olan kartını ekle.</p>}
        {cards.map((c: CreditCard) => {
          const settled = c.statement_amount === 0;
          const when = countdown(c.due_date, settled);
          return (
            <Entry key={c.id} when={when} title={c.name}
              note={<>asgari {moneyExact(c.minimum_amount)}{c.due_date && <> · son ödeme {trDate(c.due_date)}</>}</>}
              amount={c.statement_amount}
              tone={settled ? "settled" : when.tone === "late" ? "late" : "due"}
            >
              <button disabled={busy || c.minimum_amount <= 0} onClick={() => post(`/api/cards/${c.id}/pay`, { mode: "min" })}>Asgariyi öde</button>
              <button disabled={busy || settled} onClick={() => askAmount(`/api/cards/${c.id}/pay`, c.statement_amount)}>Kısmi</button>
              {settled ? (
                <button className={panel === `card:${c.id}:new` ? "" : "go"} onClick={() => toggle(`card:${c.id}:new`)}>
                  {panel === `card:${c.id}:new` ? "Vazgeç" : "Yeni ekstre gir"}
                </button>
              ) : (
                <>
                  <button className="go" disabled={busy} onClick={() => post(`/api/cards/${c.id}/pay`, { mode: "full" })}>Borcu kapat</button>
                  <button onClick={() => toggle(`card:${c.id}:new`)}>{panel === `card:${c.id}:new` ? "Vazgeç" : "Yeni ekstre"}</button>
                </>
              )}
              <button onClick={() => toggle(`card:${c.id}`)}>{editLabel(`card:${c.id}`)}</button>
              <button className="drop" disabled={busy} onClick={() => drop(`/api/cards/${c.id}`, c.name)}>Sil</button>
              {panel === `card:${c.id}:new` && (
                <InlineForm busy={busy} submit="Ekstreyi işle" onSubmit={submit(`/api/cards/${c.id}/statement`)}
                  // Asgari her ay aynı orandan çıkıyor: kartın kendi geçmişinden türetiliyor.
                  // Elle değiştirilebilir; değiştirilirse bir dahakine yeni oran öğrenilir.
                  onInput={(form, changed) => {
                    if (changed !== "statement_amount" || !c.min_ratio) return;
                    const tutar = Number((form.elements.namedItem("statement_amount") as HTMLInputElement).value);
                    const asgari = form.elements.namedItem("minimum_amount") as HTMLInputElement;
                    if (Number.isFinite(tutar) && tutar > 0) {
                      asgari.value = (Math.round(tutar * c.min_ratio * 100) / 100).toFixed(2);
                    }
                  }}
                  fields={[
                    { name: "statement_amount", label: "Dönem borcu", type: "number", step: "0.01", min: "0" },
                    {
                      name: "minimum_amount",
                      label: c.min_ratio ? `Asgari (%${Math.round(c.min_ratio * 100)})` : "Asgari",
                      type: "number", step: "0.01", min: "0",
                    },
                    { name: "due_date", label: "Son ödeme", type: "date", value: c.due_date ? nextMonthDate(c.due_date) : "" },
                  ]} />
              )}
              {panel === `card:${c.id}` && (
                <InlineForm busy={busy} submit="Kaydet" onSubmit={submit(`/api/cards/${c.id}`, "PATCH")}
                  fields={[
                    { name: "name", label: "Kart", value: c.name, list: "oneri-kart" },
                    { name: "statement_amount", label: "Dönem borcu", type: "number", step: "0.01", min: "0", value: c.statement_amount },
                    { name: "minimum_amount", label: "Asgari", type: "number", step: "0.01", min: "0", value: c.minimum_amount },
                    { name: "due_date", label: "Son ödeme", type: "date", value: c.due_date },
                  ]} />
              )}
            </Entry>
          );
        })}
      </div>
      <details>
        <summary>Kart ekle</summary>
        <form onSubmit={submit("/api/cards")}>
          <label>Kart<input name="name" list="oneri-kart" required maxLength={120} placeholder="Bonus" /></label>
          <label>Dönem borcu<input name="statement_amount" type="number" step="0.01" min="0" required placeholder="8400" /></label>
          <label>Asgari<input name="minimum_amount" type="number" step="0.01" min="0" required placeholder="1680" /></label>
          <label>Son ödeme<input name="due_date" type="date" /></label>
          <button className="go" disabled={busy}>Kaydet</button>
        </form>
      </details>
    </section>
  );

  /* ---------------- Krediler ---------------- */

  const loansView = (
    <section>
      <h2>Krediler</h2>
      <div className="entries">
        {loans.length === 0 && <p className="blank">Kredi yok. Devam eden taksitlerini ekle.</p>}
        {loans.map((l: Loan) => {
          const left = l.total_installments - l.paid_installments;
          const when = countdown(l.next_due_date, left === 0);
          return (
            <Entry key={l.id} when={when} title={l.name}
              note={left === 0 ? "tüm taksitler ödendi" : `${left} taksit kaldı · aylık ${moneyExact(l.installment_amount)}`}
              amount={left * l.installment_amount}
              tone={left === 0 ? "settled" : when.tone === "late" ? "late" : "due"}
              extra={
                <div className="meter" title={`${l.paid_installments}/${l.total_installments} ödendi`}>
                  {Array.from({ length: l.total_installments }, (_, i) => (
                    <i key={i} className={i < l.paid_installments ? "paid" : ""} />
                  ))}
                </div>
              }
            >
              <button className="go" disabled={busy || left === 0} onClick={() => post(`/api/loans/${l.id}/pay`, {})}>Taksiti öde</button>
              <button onClick={() => toggle(`loan:${l.id}`)}>{editLabel(`loan:${l.id}`)}</button>
              <button className="drop" disabled={busy} onClick={() => drop(`/api/loans/${l.id}`, l.name)}>Sil</button>
              {panel === `loan:${l.id}` && (
                <InlineForm busy={busy} submit="Kaydet" onSubmit={submit(`/api/loans/${l.id}`, "PATCH")}
                  fields={[
                    { name: "name", label: "Kredi", value: l.name, list: "oneri-kredi" },
                    { name: "installment_amount", label: "Taksit", type: "number", step: "0.01", min: "0.01", value: l.installment_amount },
                    { name: "total_installments", label: "Toplam taksit", type: "number", min: "1", value: l.total_installments },
                    { name: "paid_installments", label: "Ödenen", type: "number", min: "0", value: l.paid_installments },
                    { name: "next_due_date", label: "Sıradaki vade", type: "date", value: l.next_due_date },
                  ]} />
              )}
            </Entry>
          );
        })}
      </div>
      <details>
        <summary>Kredi ekle</summary>
        <form onSubmit={submit("/api/loans")}>
          <label>Kredi<input name="name" list="oneri-kredi" required maxLength={120} placeholder="İhtiyaç kredisi" /></label>
          <label>Taksit<input name="installment_amount" type="number" step="0.01" min="0.01" required placeholder="3250" /></label>
          <label>Toplam taksit<input name="total_installments" type="number" min="1" max="1000" required placeholder="12" /></label>
          <label>Ödenen<input name="paid_installments" type="number" min="0" defaultValue={0} /></label>
          <label>Sıradaki vade<input name="next_due_date" type="date" /></label>
          <button className="go" disabled={busy}>Kaydet</button>
        </form>
      </details>
    </section>
  );

  /* ---------------- Sabit giderler ---------------- */

  const expensesView = (
    <section>
      <h2>Sabit giderler</h2>
      <div className="entries">
        {expenses.length === 0 && <p className="blank">Kira, aidat, abonelik — her ay çıkan sabit ödemeleri ekle.</p>}
        {expenses.map((e: RecurringExpense) => {
          const ended = !!e.renews_on && e.renews_on < today();
          const when = countdown(e.next_due_date, ended);
          const left = e.renews_on ? [...occurrences(e, 600)].length : null;
          const renewIn = e.renews_on ? daysUntil(e.renews_on) : null;
          return (
            <Entry key={e.id}
              when={ended ? { tone: "late", head: "bitti", tail: "" } : when}
              title={e.name}
              note={<>
                aylık {moneyExact(e.amount)}
                {e.renews_on ? (
                  ended ? <> · <b className="flag late">sözleşme bitti, yenile</b></> : (
                    <>
                      {" · "}
                      <span className={renewIn !== null && renewIn < 60 ? "flag due" : undefined}>
                        {trDate(e.renews_on)} tarihinde yenilenecek
                      </span>
                      {left !== null && <> · {left} ödeme kaldı</>}
                    </>
                  )
                ) : <> · süresiz</>}
              </>}
              amount={left !== null ? left * e.amount : e.amount}
              suffix={left === null ? "/ay" : undefined}
              tone={ended ? "late" : "due"}
            >
              <button className="go" disabled={busy || ended} onClick={() => post(`/api/expenses/${e.id}/pay`, {})}>Bu ayı öde</button>
              <button onClick={() => toggle(`expense:${e.id}`)}>
                {panel === `expense:${e.id}` ? "Vazgeç" : ended ? "Yenile" : "Düzenle"}
              </button>
              <button className="drop" disabled={busy} onClick={() => drop(`/api/expenses/${e.id}`, e.name)}>Sil</button>
              {panel === `expense:${e.id}` && (
                <InlineForm busy={busy} submit="Kaydet" onSubmit={submit(`/api/expenses/${e.id}`, "PATCH")}
                  fields={[
                    { name: "name", label: "Gider", value: e.name, list: "oneri-gider" },
                    { name: "amount", label: "Aylık tutar", type: "number", step: "0.01", min: "0.01", value: e.amount },
                    { name: "next_due_date", label: "Sıradaki ödeme", type: "date", value: e.next_due_date },
                    { name: "renews_on", label: "Sözleşme bitişi", type: "date", value: e.renews_on },
                  ]} />
              )}
            </Entry>
          );
        })}
      </div>
      <details>
        <summary>Sabit gider ekle</summary>
        <form onSubmit={submit("/api/expenses")}>
          <label>Gider<input name="name" list="oneri-gider" required maxLength={120} placeholder="Kira" /></label>
          <label>Aylık tutar<input name="amount" type="number" step="0.01" min="0.01" required placeholder="24000" /></label>
          <label>İlk ödeme<input name="next_due_date" type="date" required /></label>
          <label>Sözleşme bitişi<input name="renews_on" type="date" /></label>
          <button className="go" disabled={busy}>Kaydet</button>
        </form>
      </details>
    </section>
  );

  /* ---------------- Hareketler ---------------- */

  const byMonth = logs.reduce<Record<string, typeof logs>>((acc, p) => {
    (acc[p.paid_at.slice(0, 7)] ??= []).push(p);
    return acc;
  }, {});

  const paid = paidByMonth(state, 12);
  const paidMax = Math.max(...paid.map((m) => m.total));
  // Tek dolu ay varken grafik tek bardan ibaret kalır; o zaman aylık toplam zaten
  // listenin başlığında yazıyor. Karşılaştıracak bir şey olunca çiz.
  const showTrend = paid.filter((m) => m.total > 0).length >= 2;

  const ledger = (
    <section>
      <h2>Ödeme geçmişi</h2>
      {showTrend && <PaidHistory rows={paid} />}

      {logs.length === 0 ? (
        <p className="blank">Ödeme işledikçe buraya düşer.</p>
      ) : (
        Object.entries(byMonth).map(([m, items]) => (
          <div className="period" key={m}>
            <div className="period-head">
              <b>{monthLabel(m, { month: "long", year: "numeric" })}</b>
              <span className="num">{moneyExact(items.reduce((a, p) => a + p.amount, 0))}</span>
            </div>
            <ul className="ledger">
              {items.map((p) => (
                <li key={p.id}>
                  <span>{p.note} <span className="num">{trDate(p.paid_at)}</span></span>
                  <span className="tail">
                    <b className="num">{moneyExact(p.amount)}</b>
                    <button disabled={busy || !p.prev} onClick={() => post(`/api/payments/${p.id}/undo`, {})}>Geri al</button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );

  /* ---------------- Bu ay: ödeme listesi ---------------- */

  const rows = monthPlan(state, month);
  const doneRows = rows.filter((r) => r.done);
  const paidSum = doneRows.reduce((a, r) => a + r.amount, 0);
  const restSum = rows.filter((r) => !r.done).reduce((a, r) => a + r.amount, 0);

  // Kutuyu işaretlemek = ödemeyi işlemek. İşareti kaldırmak = o hareketi geri almak.
  const PAY: Record<Kind, (id: number, amount: number) => [string, unknown]> = {
    record: (id, amount) => [`/api/records/${id}/pay`, { amount }],
    card: (id) => [`/api/cards/${id}/pay`, { mode: "full" }],
    loan: (id) => [`/api/loans/${id}/pay`, {}],
    expense: (id) => [`/api/expenses/${id}/pay`, {}],
  };

  const toggleRow = (r: PlanRow) => {
    if (r.done) {
      if (!r.undoable) return setNote("Bu hareket geri alınamıyor.");
      return post(`/api/payments/${r.logId}/undo`, {});
    }
    const [url, body] = PAY[r.kind!](r.id!, r.amount);
    return post(url, body);
  };

  const monthView = (
    <section>
      <h2>Ödeme listesi</h2>
      <div className="monthbar">
        <button onClick={() => setMonth(monthKey(`${month}-01`, -1))} aria-label="Önceki ay">‹</button>
        <b>{monthLabel(month, { month: "long", year: "numeric" })}</b>
        <button onClick={() => setMonth(monthKey(`${month}-01`, 1))} aria-label="Sonraki ay">›</button>
        {month !== monthKey(today()) && <button className="today" onClick={() => setMonth(monthKey(today()))}>Bu aya dön</button>}
      </div>

      {rows.length === 0 ? (
        <p className="blank">Bu ayda ne ödeme var ne de yapılmış bir ödeme.</p>
      ) : (
        <>
          <div className="tally">
            <div className="bar"><i style={{ width: `${(paidSum / (paidSum + restSum || 1)) * 100}%` }} /></div>
            <p>
              <b className="num">{doneRows.length}/{rows.length}</b> ödendi
              {" — "}<b className="num">{money(paidSum)}</b> yapıldı
              {restSum > 0 && <>, <b className="num">{money(restSum)}</b> kaldı</>}
            </p>
          </div>

          <ul className="checklist">
            {rows.map((r) => (
              <li key={r.key} className={r.done ? "done" : r.date < today() ? "late" : ""}>
                <label>
                  <input type="checkbox" checked={r.done} disabled={busy || (r.done && !r.undoable)}
                    onChange={() => toggleRow(r)} />
                  <span className="body">
                    <b>{r.title}</b>
                    <em>{[r.detail, trDate(r.date)].filter(Boolean).join(" · ")}</em>
                  </span>
                  <span className="num sum">{moneyExact(r.amount)}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );

  /* ---------------- Ayarlar ---------------- */

  const st = state.settings;
  const sizeKB = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

  const restore = async (file: File) => {
    if (!confirm(`"${file.name}" geri yüklenecek. Mevcut tüm kayıtlar ve ayarlar bu yedekle DEĞİŞTİRİLECEK. Devam?`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/restore", { method: "POST", body: file });
      const data = await res.json();
      if (!res.ok) return setError(data.error ?? "Geri yükleme başarısız"), setNote("");
      setState(data); setError(""); setNote("Yedek geri yüklendi.");
    } finally { setBusy(false); }
  };

  const submitPin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = e.currentTarget;
    const d = Object.fromEntries(new FormData(f));
    if (await post("/api/settings/pin", d)) { f.reset(); setNote(st.pinSet ? "PIN değiştirildi." : "PIN belirlendi."); }
  };

  const settingsView = (
    <section>
      <h2>Ayarlar</h2>

      <h3 className="sub">Görünüm</h3>
      <div className="segmented" role="group" aria-label="Tema">
        {([["system", "Sistem"], ["light", "Açık"], ["dark", "Koyu"]] as const).map(([v, label]) => (
          <button key={v} className={st.theme === v ? "on" : ""} disabled={busy}
            onClick={() => write("/api/settings", { theme: v }, "PATCH")}>
            {label}
          </button>
        ))}
      </div>

      <h3 className="sub">Erişim</h3>
      <p className="hint">
        {st.pinSet
          ? "PIN açık. Uygulamayı ev ağına açtıysan bu tek koruma — düz HTTP üzerinden çalıştığı için trafiği dinleyen biri yine görebilir."
          : "PIN yok; sunucuya ulaşabilen herkes tüm kayıtları okuyup değiştirebilir. Telefondan kullanacaksan belirle."}
      </p>
      <form className="settings" onSubmit={submitPin}>
        {st.pinSet && (
          <label>Mevcut PIN
            <input name="current" type="password" inputMode="numeric" pattern="\d*" maxLength={8} required autoComplete="current-password" />
          </label>
        )}
        <label>{st.pinSet ? "Yeni PIN" : "PIN (4-8 rakam)"}
          <input name="pin" type="password" inputMode="numeric" pattern="\d{4,8}" maxLength={8} required autoComplete="new-password" />
        </label>
        <button className="go" disabled={busy}>{st.pinSet ? "PIN'i değiştir" : "PIN belirle"}</button>
      </form>
      {st.pinSet && (
        <div className="tools">
          <button disabled={busy} onClick={() => {
            const current = prompt("PIN'i kaldırmak için mevcut PIN:");
            if (current) post("/api/settings/pin", { pin: "", current });
          }}>PIN'i kaldır</button>
          <button disabled={busy} onClick={() => send("/api/auth", { method: "DELETE" }).then(() => { setState(null); setLocked(true); })}>
            Bu cihazdan çıkış yap
          </button>
        </div>
      )}

      <h3 className="sub">Ad önerileri</h3>
      <p className="hint">
        Kart, kredi ve gider eklerken açılan öneri listeleri. Satır başına bir ad. Alanlar serbest
        metin kalır — liste yalnızca yazmayı kısaltır. Bir listeyi tamamen boşaltırsan varsayılana döner.
      </p>
      <form className="settings lists" onSubmit={submit("/api/settings", "PATCH")}>
        {([["kart", "Kart"], ["kredi", "Kredi"], ["gider", "Sabit gider"]] as const).map(([k, label]) => (
          <label key={k}>
            {label} <span className="count">{st.names[k].length}</span>
            <textarea name={`names_${k}`} rows={8} defaultValue={st.names[k].join("\n")} spellCheck={false} />
          </label>
        ))}
        <button className="go" disabled={busy}>Listeleri kaydet</button>
      </form>

      <h3 className="sub">Telegram bildirimleri</h3>
      <p className="hint">
        {st.telegramConfigured
          ? <>Kurulu{st.source === "env" ? " (.env dosyasından)" : ""}. Bot token yeniden gösterilmez; değiştirmek için yenisini yaz.</>
          : <>BotFather'dan bot oluştur, token'ı buraya yapıştır. Sohbet kimliğini @userinfobot söyler.</>}
      </p>
      <form className="settings" onSubmit={submit("/api/settings", "PATCH")}>
        <label>Bot token
          <input name="telegram_token" type="password" autoComplete="off"
            placeholder={st.telegramConfigured ? "kayıtlı — değiştirmek için yaz" : "123456789:AAE..."} />
        </label>
        <label>Sohbet kimliği
          <input name="telegram_chat" inputMode="numeric" defaultValue={st.telegramChat} placeholder="123456789" />
        </label>
        <label>Sessiz saat dışı
          <input name="notify_hours" defaultValue={st.notifyHours} placeholder="9-22" />
        </label>
        <button className="go" disabled={busy}>Kaydet</button>
      </form>

      <h3 className="sub">Neyi haber versin</h3>
      <form className="settings triggers" onSubmit={submit("/api/settings", "PATCH")}>
        {TRIGGERS.map(([id, label, desc]) => (
          <label className="check" key={id}>
            <input type="checkbox" name={id} defaultChecked={st.triggers.includes(id)} />
            <span><b>{label}</b><em>{desc}</em></span>
          </label>
        ))}
        <button className="go" disabled={busy}
          onClick={(e) => {
            // FormData yalnızca işaretli kutuları taşır; sunucu tek alan bekliyor.
            const form = e.currentTarget.form!;
            const on = TRIGGERS.map(([id]) => id).filter((id) => (form.elements.namedItem(id) as HTMLInputElement).checked);
            (form.elements.namedItem("triggers") as HTMLInputElement).value = on.join(",");
          }}>
          Kaydet
        </button>
        <input type="hidden" name="triggers" defaultValue="" />
      </form>

      <h3 className="sub">Bildirimi sına</h3>
      <div className="tools">
        <button className="go" disabled={busy || !st.telegramConfigured}
          onClick={() => post("/api/notify/test", {}).then(() => setNote("Test mesajı gönderildi."))}>
          Test bildirimi gönder
        </button>
        <button disabled={busy} onClick={async () => {
          const r = await fetch("/api/notify/preview").then((x) => x.json());
          setPreview(r.count > 0 ? r.text : "Şu an gönderilecek yeni bir olay yok.");
        }}>
          Şu an ne gönderilir?
        </button>
        <button disabled={busy}
          onClick={() => confirm("Gönderilmiş bildirim kayıtları silinsin mi? Aynı olaylar tekrar haber verilir.") &&
            post("/api/notify/forget", {}).then(() => setNote("Bildirim geçmişi sıfırlandı."))}>
          Bildirim geçmişini sıfırla
        </button>
      </div>
      {preview !== null && (
        <pre className="preview" onClick={() => setPreview(null)} title="kapatmak için tıkla">{preview}</pre>
      )}

      <h3 className="sub">Veri</h3>
      <p className="hint">
        {state.stats.records} kişi · {state.stats.cards} kart · {state.stats.loans} kredi ·{" "}
        {state.stats.expenses} sabit gider · {state.stats.logs} hareket · {sizeKB(state.stats.bytes)}
        {state.stats.since && <> · ilk kayıt {trDate(state.stats.since)}</>}
      </p>
      <div className="tools">
        <a className="dl" href="/api/backup">Yedek indir</a>
        <label className="dl upload">
          Yedekten geri yükle
          <input type="file" accept=".sqlite,application/vnd.sqlite3,application/octet-stream" disabled={busy}
            onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) restore(f); }} />
        </label>
      </div>
      <p className="hint">
        Geri yükleme mevcut tüm kayıtların ve ayarların yerine yedektekileri yazar. Dosya doğrulanamazsa
        hiçbir şeye dokunulmaz.
      </p>
    </section>
  );

  const VIEWS: Record<string, React.ReactNode> = {
    "/": dashboard, "/kisiler": people, "/kartlar": cardsView,
    "/krediler": loansView, "/giderler": expensesView, "/ay": monthView, "/hareketler": ledger,
    "/ayarlar": settingsView,
  };

  return (
    <div className="shell">
      {Object.entries(st.names).map(([ad, secenekler]) => (
        <datalist id={`oneri-${ad}`} key={ad}>
          {secenekler.map((o) => <option value={o} key={o} />)}
        </datalist>
      ))}

      <aside className="rail">
        <button className="mark" onClick={() => go("/")}>Vadeo</button>
        <nav>
          {ROUTES.map((r) => {
            const urgent = urgentOf(r.kind);
            return (
              <button key={r.path} className={path === r.path ? "on" : ""} onClick={() => go(r.path)}>
                <span>{r.label}</span>
                {urgent > 0 ? (
                  <em className="num urgent" title="gecikmiş veya 7 gün içinde">{urgent}</em>
                ) : (
                  countOf[r.path] ? <em className="num">{countOf[r.path]}</em> : null
                )}
              </button>
            );
          })}
        </nav>
        <div className="rail-foot">
          <span>30 günde ödenecek</span>
          <b>{money(soonTotal)}</b>
          <time className="num" dateTime={today()}>{longDate()}</time>
        </div>
      </aside>

      <main className="view">
        {error && <p className="alert">{error}</p>}
        {note && !error && <p className="ok">{note}</p>}
        {VIEWS[path]}
      </main>
    </div>
  );
}
