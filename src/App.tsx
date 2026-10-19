import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Evaluation, ParsedMetar, evaluate, parseMetar } from "./lib/metar";
import { PageReading, ReadError, ReaderStatus, SOURCE_URL, getCustomProxy, readSourcePage, setCustomProxy } from "./lib/source";
import {
  DEFAULT_SETTINGS,
  Settings,
  cloudModeLabel,
  describeChanges,
  fmtCloudLimit,
  fmtInterval,
  fmtVisLimit,
  loadSettings,
  saveSettings,
} from "./lib/settings";
import SettingsPanel from "./components/SettingsPanel";
import { isAudioReady, startAlarm, stopAlarm, unlockAudio } from "./lib/alarm";
import { cn } from "./utils/cn";

const RETRY_MS = 60 * 1000; // po nieudanym odczycie — ponowienie po minucie
const LS_LOG = "eppw-log-v2";
const LS_PREV = "eppw-prev-v1";
const LS_LASTOBS = "eppw-lastobs-v1";

type Param = "VIS" | "CLD" | "CFG";
interface LogEntry {
  id: string;
  detectedAt: string;
  metarTime: string | null;
  param: Param;
  direction: "down" | "up" | "cfg";
  value: string;
  raw: string;
  ackAt?: string;
  simulated?: boolean;
  /** Progi obowiązujące w chwili zdarzenia — dzięki temu dziennik pozostaje czytelny po ich zmianie. */
  visLimitM?: number;
  cloudLimitFt?: number;
}

const fmtUTC = (d: Date) =>
  d.toLocaleString("pl-PL", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " UTC";
const fmtLocal = (d: Date) =>
  d.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtClock = (d: Date) => d.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtVis = (m: number | null, cavok = false) =>
  m === null ? "—" : cavok ? "CAVOK (≥10 km)" : m >= 10000 ? "≥ 10 km" : m >= 5000 ? `${(m / 1000).toFixed(0)} km` : `${m} m`;
const fmtCloud = (ft: number | null) => (ft === null ? "brak / NSC" : `${ft} ft`);
const fmtAge = (ms: number) => (ms < 60000 ? "przed chwilą" : `${Math.round(ms / 60000)} min temu`);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [metar, setMetar] = useState<ParsedMetar | null>(null);
  const [reading, setReading] = useState<PageReading | null>(null);
  const [statuses, setStatuses] = useState<ReaderStatus[]>([]);
  const [lastOk, setLastOk] = useState<Date | null>(null);
  const [nextFetch, setNextFetch] = useState<number>(Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [log, setLog] = useState<LogEntry[]>(() => load(LS_LOG, []));
  const [alarm, setAlarm] = useState<LogEntry[] | null>(null);
  const [armed, setArmed] = useState(false);
  const [sim, setSim] = useState("EPPW 171400Z 24008KT 2500 BR BKN002 08/07 Q1012");
  const [customProxy, setCustomProxyInput] = useState(() => getCustomProxy());

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const metarRef = useRef<ParsedMetar | null>(null);
  metarRef.current = metar;
  const prevRef = useRef<Evaluation | null>(load<Evaluation | null>(LS_PREV, null));
  const lastRawRef = useRef<string>("");
  const lastObsRef = useRef<number | null>(load<number | null>(LS_LASTOBS, null));
  const lastAttemptRef = useRef<number | null>(null);
  const loadingRef = useRef(false);
  const nextFetchRef = useRef<number>(0);
  const failStreak = useRef(0);
  const staleStreak = useRef(0);

  useEffect(() => localStorage.setItem(LS_LOG, JSON.stringify(log)), [log]);

  const evaluation = useMemo(() => (metar ? evaluate(metar, settings.cloudMode, settings) : null), [metar, settings]);
  const below = !!evaluation && (evaluation.visBelow === true || evaluation.cloudBelow === true);
  const visLabel = fmtVisLimit(settings.visLimitM);
  const cloudLabel = fmtCloudLimit(settings.cloudLimitFt);
  const intervalLabel = fmtInterval(settings.refreshSec);

  /** Porównuje nową depeszę z poprzednim stanem i w razie przejścia przez próg uruchamia alarm. */
  const process = useCallback((raw: string, simulated = false) => {
    if (!simulated && raw === lastRawRef.current) return;
    lastRawRef.current = raw;
    const cfg = settingsRef.current;
    const p = parseMetar(raw);
    const ev = evaluate(p, cfg.cloudMode, cfg);
    setMetar(p);
    const prev = prevRef.current;
    const events: LogEntry[] = [];
    const stamp = new Date().toISOString();
    const base = { detectedAt: stamp, metarTime: p.obsTime, raw, simulated, visLimitM: cfg.visLimitM, cloudLimitFt: cfg.cloudLimitFt };
    if (prev) {
      if (prev.visBelow !== null && ev.visBelow !== null && prev.visBelow !== ev.visBelow) {
        events.push({ ...base, id: crypto.randomUUID(), param: "VIS", direction: ev.visBelow ? "down" : "up", value: fmtVis(p.visibilityM, p.cavok) });
      }
      if (prev.cloudBelow !== null && ev.cloudBelow !== null && prev.cloudBelow !== ev.cloudBelow) {
        events.push({ ...base, id: crypto.randomUUID(), param: "CLD", direction: ev.cloudBelow ? "down" : "up", value: fmtCloud(ev.cloudBaseFt) });
      }
    }
    prevRef.current = ev;
    localStorage.setItem(LS_PREV, JSON.stringify(ev));
    if (events.length) {
      setLog((l) => [...events, ...l]);
      setAlarm((a) => [...(a ?? []), ...events]);
      startAlarm();
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("EPPW – zmiana warunków", {
          body: events
            .map((e) => {
              const lim = e.param === "VIS" ? fmtVisLimit(e.visLimitM ?? cfg.visLimitM) : fmtCloudLimit(e.cloudLimitFt ?? cfg.cloudLimitFt);
              return `${e.param === "VIS" ? "Widzialność" : "Podstawa chmur"} ${e.direction === "down" ? "PONIŻEJ" : "POWYŻEJ"} ${lim}: ${e.value}`;
            })
            .join("\n"),
        });
      }
    }
  }, []);

  /** Odczyt strony metar.czad.org/EPPW i zaplanowanie kolejnego odczytu. */
  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const intervalMs = settingsRef.current.refreshSec * 1000;
    nextFetchRef.current = Date.now() + intervalMs;
    let next = intervalMs;
    try {
      const r = await readSourcePage({
        // po 3 kolejnych "starszych kopiach" z rzędu akceptujemy to, co zgodnie pokazują czytniki
        minObsTime: staleStreak.current >= 3 ? null : lastObsRef.current,
        onStatus: setStatuses,
      });
      failStreak.current = 0;
      staleStreak.current = 0;
      const p = parseMetar(r.raw);
      if (p.obsDate) {
        lastObsRef.current = p.obsDate.getTime();
        localStorage.setItem(LS_LASTOBS, JSON.stringify(lastObsRef.current));
      }
      setReading(r);
      setLastOk(new Date());
      setError(null);
      setErrorDetails(null);
      process(r.raw);
    } catch (e) {
      failStreak.current += 1;
      next = Math.min(RETRY_MS, settingsRef.current.refreshSec * 1000);
      if (e instanceof ReadError && e.stale) {
        staleStreak.current += 1;
        setError(`Odczytana strona pokazuje starszą depeszę niż już znana — odczyt pominięty (próba ${staleStreak.current}/3, potem zaakceptuję stan ze strony).`);
      } else {
        setError(`Nie udało się odczytać strony ${SOURCE_URL.replace("https://", "")} (nieudanych prób z rzędu: ${failStreak.current}).`);
      }
      setErrorDetails((e as Error).message);
    } finally {
      lastAttemptRef.current = Date.now();
      nextFetchRef.current = lastAttemptRef.current + next;
      setNextFetch(nextFetchRef.current);
      loadingRef.current = false;
      setLoading(false);
    }
  }, [process]);

  // Zegar + harmonogram odczytów (odporny na usypianie karty w tle)
  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      setNow(Date.now());
      setNextFetch(nextFetchRef.current);
      if (Date.now() >= nextFetchRef.current && !loadingRef.current) void refresh();
    }, 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() >= nextFetchRef.current) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Migający tytuł karty podczas alarmu
  useEffect(() => {
    if (!alarm) {
      document.title = below ? `▼ EPPW poniżej minimów – ${visLabel} / ${cloudLabel}` : `EPPW Strażnik Minimów – ${visLabel} / ${cloudLabel}`;
      return;
    }
    let on = false;
    const id = setInterval(() => {
      on = !on;
      document.title = on ? "🚨 ALARM EPPW – naciśnij RESET" : "EPPW – zmiana warunków";
    }, 800);
    return () => clearInterval(id);
  }, [alarm, below, visLabel, cloudLabel]);

  /**
   * Zapis nowych ustawień: przelicza stan odniesienia (bez fałszywego alarmu),
   * dopisuje wpis do dziennika i natychmiast przestawia harmonogram odczytów.
   */
  const applySettings = useCallback((next: Settings) => {
    const prev = settingsRef.current;
    const changes = describeChanges(prev, next);
    if (!changes.length) return;
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);

    const m = metarRef.current;
    if (m) {
      const ev = evaluate(m, next.cloudMode, next);
      prevRef.current = ev;
      localStorage.setItem(LS_PREV, JSON.stringify(ev));
    }

    setLog((l) => [
      {
        id: crypto.randomUUID(),
        detectedAt: new Date().toISOString(),
        metarTime: m?.obsTime ?? null,
        param: "CFG",
        direction: "cfg",
        value: changes.join(" · "),
        raw: m?.raw ?? "",
        visLimitM: next.visLimitM,
        cloudLimitFt: next.cloudLimitFt,
      },
      ...l,
    ]);

    // nowy odstęp liczony od ostatniej próby odczytu — skrócenie czasu działa od razu
    const base = lastAttemptRef.current ?? Date.now();
    nextFetchRef.current = base + next.refreshSec * 1000;
    setNextFetch(nextFetchRef.current);
  }, []);

  const reset = () => {
    stopAlarm();
    if (alarm) {
      const ids = new Set(alarm.map((a) => a.id));
      const ack = new Date().toISOString();
      setLog((l) => l.map((e) => (ids.has(e.id) && !e.ackAt ? { ...e, ackAt: ack } : e)));
    }
    setAlarm(null);
  };

  const arm = async () => {
    unlockAudio();
    setArmed(true);
    if ("Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
  };

  const saveCustomProxy = () => {
    setCustomProxy(customProxy);
    setCustomProxyInput(getCustomProxy());
    nextFetchRef.current = 0;
  };

  const forceRefresh = () => {
    nextFetchRef.current = 0;
    void refresh();
  };

  const exportCsv = () => {
    const head = ["Wykryto UTC", "Wykryto czas lokalny", "Czas METAR", "Parametr", "Kierunek", "Wartość", "Próg widzialności", "Próg podstawy chmur", "Potwierdzono (RESET) UTC", "Symulacja", "METAR"];
    const rows = log.map((e) => [
      fmtUTC(new Date(e.detectedAt)),
      fmtLocal(new Date(e.detectedAt)),
      e.metarTime ?? "",
      e.param === "VIS" ? "Widzialność" : e.param === "CLD" ? "Podstawa chmur" : "Ustawienia",
      e.param === "CFG" ? "zmiana konfiguracji" : e.direction === "down" ? "Pogorszenie (poniżej)" : "Poprawa (powyżej)",
      e.value,
      e.visLimitM ? fmtVisLimit(e.visLimitM) : "",
      e.cloudLimitFt ? fmtCloudLimit(e.cloudLimitFt) : "",
      e.ackAt ? fmtUTC(new Date(e.ackAt)) : "",
      e.simulated ? "TAK" : "",
      e.raw,
    ]);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `EPPW_dziennik_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const countdown = mmss(nextFetch - now);
  const metarAgeMin = metar?.obsDate ? Math.round((now - metar.obsDate.getTime()) / 60000) : null;
  const okAge = lastOk ? now - lastOk.getTime() : null;
  const staleWarnMs = Math.max(2.5 * settings.refreshSec * 1000, 10 * 60 * 1000);
  const dataStale = okAge !== null && okAge > staleWarnMs;
  const pageSays = reading
    ? (["WIDZIALNOŚĆ", "CHMURY", "POMIAR"] as const).filter((k) => reading.decoded[k]).map((k) => ({ k, v: reading.decoded[k] }))
    : [];
  const visMax = Math.max(10000, Math.ceil((settings.visLimitM * 1.5) / 1000) * 1000);
  const cloudMax = Math.max(1500, Math.ceil((settings.cloudLimitFt * 3) / 500) * 500);
  const alarmCount = log.filter((e) => e.param !== "CFG").length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 antialiased selection:bg-amber-400/30">
      {/* PASEK ALARMU */}
      {alarm && (
        <div className="fixed inset-x-0 top-0 z-50 animate-pulse bg-red-600 shadow-2xl shadow-red-900/60">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-4 sm:flex-row sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-red-100">Alarm · zmiana warunków na EPPW</p>
              {alarm.map((a) => (
                <p key={a.id} className="text-lg font-black sm:text-xl">
                  {a.param === "VIS" ? "Widzialność" : "Podstawa chmur"} {a.direction === "down" ? "spadła PONIŻEJ" : "wzrosła POWYŻEJ"}{" "}
                  {a.param === "VIS" ? fmtVisLimit(a.visLimitM ?? settings.visLimitM) : fmtCloudLimit(a.cloudLimitFt ?? settings.cloudLimitFt)} → {a.value}
                  <span className="ml-2 text-sm font-semibold text-red-100">(METAR {a.metarTime})</span>
                </p>
              ))}
            </div>
            <button onClick={reset} className="rounded-xl border-4 border-white bg-white px-10 py-4 text-2xl font-black tracking-widest text-red-600 hover:bg-red-50 focus:outline-none focus:ring-4 focus:ring-white/50">
              RESET
            </button>
          </div>
        </div>
      )}

      {/* NAWIGACJA */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <a href="#top" className="flex items-center gap-2 font-bold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-400 text-slate-950">✈</span>
            <span>EPPW <span className="text-amber-400">Strażnik Minimów</span></span>
          </a>
          <nav className="hidden gap-6 text-sm text-slate-400 lg:flex">
            <a href="#monitor" className="hover:text-white">Monitor</a>
            <a href="#ustawienia" className="hover:text-white">Ustawienia</a>
            <a href="#dziennik" className="hover:text-white">Dziennik</a>
            <a href="#jak" className="hover:text-white">Jak to działa</a>
            <a href="#zrodlo" className="hover:text-white">Źródło danych</a>
            <a href="#faq" className="hover:text-white">FAQ</a>
          </nav>
          <StatusPill below={below} alarm={!!alarm} ready={!!evaluation} />
        </div>
      </header>

      <main id="top">
        {/* HERO */}
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(251,191,36,0.12),transparent_60%)]" />
          <div className="relative mx-auto grid max-w-6xl gap-10 px-4 pb-12 pt-14 lg:grid-cols-[1.2fr_1fr] lg:pt-20">
            <div>
              <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-amber-300">
                Lotnisko Powidz · EPPW · METAR odczytywany ze strony co {intervalLabel}
              </p>
              <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-5xl lg:text-6xl">
                Nie musisz wpatrywać się w depesze.{" "}
                <span className="text-amber-400">Usłyszysz każdą zmianę.</span>
              </h1>
              <p className="mt-5 max-w-xl text-lg text-slate-300">
                Strażnik Minimów co {intervalLabel} odczytuje stronę metar.czad.org/EPPW i pilnuje dwóch granic:{" "}
                <strong className="text-white">widzialności {visLabel}</strong> i <strong className="text-white">podstawy chmur {cloudLabel}</strong>.
                Gdy warunki spadną poniżej lub wrócą powyżej progu — rozlega się alarm, a dokładny czas zmiany trafia do dziennika.
                Progi i częstotliwość odczytu <a href="#ustawienia" className="text-amber-400 underline decoration-amber-400/40 hover:decoration-amber-400">ustawisz pod monitorem</a>.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                {!armed ? (
                  <button onClick={arm} className="rounded-xl bg-amber-400 px-6 py-3.5 font-bold text-slate-950 shadow-lg shadow-amber-500/20 hover:bg-amber-300">
                    🔔 Uzbrój alarm dźwiękowy
                  </button>
                ) : (
                  <span className="rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-6 py-3.5 font-bold text-emerald-300">
                    ✓ Alarm uzbrojony {isAudioReady() ? "" : "(kliknij gdziekolwiek, by odblokować dźwięk)"}
                  </span>
                )}
                <a href="#monitor" className="rounded-xl border border-white/15 px-6 py-3.5 font-semibold hover:bg-white/5">
                  Zobacz bieżące warunki ↓
                </a>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Przeglądarki blokują dźwięk do pierwszego kliknięcia — uzbrój alarm raz na początku zmiany.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 self-center">
              <HeroStat label="Próg widzialności" value={visLabel} sub={`${settings.visLimitM} m`} href="#ustawienia" />
              <HeroStat label="Próg podstawy chmur" value={cloudLabel} sub={settings.cloudMode === "ceiling" ? "BKN / OVC / VV" : "każda warstwa"} href="#ustawienia" />
              <HeroStat label="Odczyt strony" value={intervalLabel} sub={loading ? "trwa odczyt…" : `następny za ${countdown}`} href="#ustawienia" />
              <HeroStat label="Zapisane zmiany" value={String(alarmCount)} sub="w tej przeglądarce" href="#dziennik" />
            </div>
          </div>
        </section>

        {/* MONITOR */}
        <section id="monitor" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12">
          <SectionHead kicker="Monitor na żywo" title="Bieżące warunki na EPPW" text="Zielony — warunki powyżej progu. Czerwony — poniżej. Decyduje najgorsza z dwóch wartości." />

          <div className={cn("rounded-3xl border p-1 transition-colors", below ? "border-red-500/50 bg-red-500/10" : "border-emerald-500/30 bg-emerald-500/5")}>
            <div className="rounded-[1.35rem] bg-slate-900/80 p-5 sm:p-8">
              <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-widest text-slate-500">Stan ogólny</p>
                  <p className={cn("text-3xl font-black", !evaluation ? "text-slate-500" : below ? "text-red-400" : "text-emerald-400")}>
                    {!evaluation ? (loading ? "Odczytuję stronę…" : "Oczekiwanie na dane…") : below ? "PONIŻEJ MINIMÓW" : "POWYŻEJ MINIMÓW"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right text-sm">
                    <p className="text-slate-400">{error ? "Ponowna próba za" : "Następny odczyt za"}</p>
                    <p className={cn("font-mono text-2xl font-bold tabular-nums", loading && "animate-pulse text-amber-300")}>{loading ? "••:••" : countdown}</p>
                  </div>
                  <button onClick={forceRefresh} disabled={loading} className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold hover:bg-white/5 disabled:opacity-50">
                    {loading ? "Odczytuję…" : "↻ Odczytaj teraz"}
                  </button>
                </div>
              </div>

              {dataStale && (
                <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                  ⚠ Ostatni udany odczyt strony: <b>{fmtAge(okAge!)}</b>. Wyświetlane wartości mogą być nieaktualne — do czasu wznowienia odczytu sprawdzaj warunki ręcznie na{" "}
                  <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="underline">metar.czad.org/EPPW</a>.
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <Gauge
                  title="Widzialność"
                  value={metar ? fmtVis(metar.visibilityM, metar.cavok) : "—"}
                  limit={`próg ${visLabel}`}
                  state={evaluation?.visBelow ?? null}
                  ratio={metar?.visibilityM != null ? Math.min(1, metar.visibilityM / visMax) : 0}
                  mark={settings.visLimitM / visMax}
                />
                <Gauge
                  title={settings.cloudMode === "ceiling" ? "Podstawa chmur (pułap BKN/OVC/VV)" : "Podstawa najniższej warstwy chmur"}
                  value={evaluation ? fmtCloud(evaluation.cloudBaseFt) : "—"}
                  limit={`próg ${cloudLabel}`}
                  state={evaluation?.cloudBelow ?? null}
                  ratio={evaluation ? (evaluation.cloudBaseFt === null ? 1 : Math.min(1, evaluation.cloudBaseFt / cloudMax)) : 0}
                  mark={settings.cloudLimitFt / cloudMax}
                />
              </div>

              <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs uppercase tracking-widest text-slate-500">
                  <span>Depesza odczytana ze strony{reading?.type === "SPECI" && <span className="ml-2 rounded bg-amber-400/20 px-1.5 py-0.5 text-amber-300">SPECI</span>}</span>
                  <span>
                    {metar?.obsTime ? `obserwacja ${metar.obsTime}` : ""}
                    {metarAgeMin !== null && <span className={cn("ml-2", metarAgeMin > 70 && "text-amber-400")}>({metarAgeMin} min temu)</span>}
                  </span>
                </div>
                <p className="break-words font-mono text-lg text-amber-200 sm:text-xl">{metar?.raw ?? "—"}</p>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-400">
                  <span>Wiatr: <b className="text-slate-200">{metar?.wind ?? "—"}</b></span>
                  <span>Temp./rosa: <b className="text-slate-200">{metar?.temp ?? "—"}</b></span>
                  <span>QNH: <b className="text-slate-200">{metar?.qnh ?? "—"}</b></span>
                  <span>Chmury: <b className="text-slate-200">{metar ? (metar.layers.map((l) => `${l.cover}${String(l.baseFt / 100).padStart(3, "0")}${l.type ?? ""}`).join(" ") || (metar.verticalVisFt !== null ? `VV${metar.verticalVisFt / 100}` : "brak")) : "—"}</b></span>
                </div>
                {pageSays.length > 0 && (
                  <div className="mt-3 border-t border-white/10 pt-3 text-sm text-slate-400">
                    <span className="mr-2 text-xs uppercase tracking-widest text-slate-500">Strona podaje</span>
                    {pageSays.map(({ k, v }) => (
                      <span key={k} className="mr-4 inline-block">
                        {k.charAt(0) + k.slice(1).toLowerCase()}: <b className="text-slate-200">{v}</b>
                      </span>
                    ))}
                    {reading?.headerTime && <span className="block text-xs text-slate-500">nagłówek strony: {reading.headerTime}</span>}
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                <span>
                  {lastOk ? (
                    <>Ostatni udany odczyt: <b className="text-slate-300">{fmtClock(lastOk)}</b> przez <b className="text-slate-300">{reading?.via}</b> ({((reading?.ms ?? 0) / 1000).toFixed(1)} s)</>
                  ) : (
                    <>Brak udanego odczytu w tej sesji</>
                  )}
                  {" · "}źródło: <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="underline hover:text-slate-300">metar.czad.org/EPPW ↗</a>
                </span>
                <span>
                  Aktywne progi: <b className="text-slate-300">{visLabel}</b> / <b className="text-slate-300">{cloudLabel}</b> ({cloudModeLabel(settings.cloudMode)}), odczyt co <b className="text-slate-300">{intervalLabel}</b>{" "}
                  <a href="#ustawienia" className="text-amber-400 underline decoration-amber-400/40 hover:decoration-amber-400">zmień ↓</a>
                </span>
              </div>

              {error && (
                <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
                  <b>{error}</b> Ponowna próba za {countdown}. Do tego czasu możesz sprawdzić warunki ręcznie na{" "}
                  <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="underline">metar.czad.org/EPPW</a>{" "}
                  albo zajrzeć do sekcji <a href="#zrodlo" className="underline">Źródło danych</a>, by zobaczyć, który kanał zawiódł.
                  {errorDetails && <details className="mt-2 text-xs text-amber-300/70"><summary className="cursor-pointer">Szczegóły techniczne</summary>{errorDetails}</details>}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* USTAWIENIA */}
        <section id="ustawienia" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12">
          <SectionHead
            kicker="Ustawienia"
            title="Dopasuj progi i częstotliwość odczytu"
            text="Domyślnie Strażnik pilnuje 3 km i 300 ft, odczytując stronę co 5 minut. Jeśli Twoja procedura wymaga innych wartości — zmień je tutaj. Ustawienia obowiązują natychmiast i zostają zapamiętane w tej przeglądarce."
          />
          <SettingsPanel settings={settings} onApply={applySettings} />
        </section>

        {/* DZIENNIK */}
        <section id="dziennik" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12">
          <SectionHead kicker="Dziennik zmian" title="Każde przejście przez próg — z dokładną godziną" text="Wpis powstaje automatycznie w chwili wykrycia zmiany. Naciśnięcie RESET dopisuje godzinę potwierdzenia. Zapisywane są też zmiany ustawień, więc zawsze wiadomo, jakie progi obowiązywały o danej godzinie." />
          <div className="mb-4 flex flex-wrap gap-2">
            <button onClick={exportCsv} disabled={!log.length} className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-slate-200 disabled:opacity-40">⬇ Eksportuj CSV (Excel)</button>
            <button onClick={() => window.print()} disabled={!log.length} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold hover:bg-white/5 disabled:opacity-40">🖨 Drukuj</button>
            <button onClick={() => { if (confirm("Usunąć wszystkie wpisy z dziennika? Tej operacji nie można cofnąć.")) setLog([]); }} disabled={!log.length} className="rounded-xl border border-red-500/30 px-4 py-2.5 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-40">Wyczyść dziennik</button>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-white/5 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Wykryto (UTC)</th>
                  <th className="px-4 py-3">Czas lokalny</th>
                  <th className="px-4 py-3">METAR</th>
                  <th className="px-4 py-3">Parametr</th>
                  <th className="px-4 py-3">Zmiana</th>
                  <th className="px-4 py-3">Wartość / próg</th>
                  <th className="px-4 py-3">RESET</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {log.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">Brak zmian od rozpoczęcia monitorowania. Gdy warunki przekroczą próg, wpis pojawi się tutaj automatycznie.</td></tr>
                )}
                {log.map((e) =>
                  e.param === "CFG" ? (
                    <tr key={e.id} className="bg-white/[0.02] text-slate-400">
                      <td className="px-4 py-3 font-mono">{fmtUTC(new Date(e.detectedAt))}</td>
                      <td className="px-4 py-3 font-mono">{fmtLocal(new Date(e.detectedAt))}</td>
                      <td className="px-4 py-3 font-mono">{e.metarTime ?? "—"}</td>
                      <td className="px-4 py-3">Ustawienia</td>
                      <td className="px-4 py-3"><span className="rounded-full bg-slate-700/60 px-2.5 py-1 text-xs font-bold text-slate-200">⚙ konfiguracja</span></td>
                      <td className="px-4 py-3" colSpan={2}>{e.value}</td>
                    </tr>
                  ) : (
                    <tr key={e.id} className="hover:bg-white/[0.03]" title={e.raw}>
                      <td className="px-4 py-3 font-mono">{fmtUTC(new Date(e.detectedAt))}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{fmtLocal(new Date(e.detectedAt))}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{e.metarTime}</td>
                      <td className="px-4 py-3">{e.param === "VIS" ? "Widzialność" : "Podstawa chmur"}{e.simulated && <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase">test</span>}</td>
                      <td className="px-4 py-3">
                        <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", e.direction === "down" ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300")}>
                          {e.direction === "down" ? "▼ poniżej progu" : "▲ powyżej progu"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-semibold">{e.value}</span>
                        <span className="ml-2 text-xs text-slate-500">
                          próg {e.param === "VIS" ? fmtVisLimit(e.visLimitM ?? DEFAULT_SETTINGS.visLimitM) : fmtCloudLimit(e.cloudLimitFt ?? DEFAULT_SETTINGS.cloudLimitFt)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-400">{e.ackAt ? fmtUTC(new Date(e.ackAt)).replace(" UTC", "") : <span className="text-amber-400">oczekuje</span>}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* JAK TO DZIAŁA */}
        <section id="jak" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12">
          <SectionHead kicker="Jak to działa" title="Trzy kroki. Zero przeoczonych zmian." />
          <div className="grid gap-4 md:grid-cols-3">
            <Step n="1" title="Ustaw progi i uzbrój" text={`Sprawdź, czy progi (${visLabel} / ${cloudLabel}) i czas odczytu (${intervalLabel}) odpowiadają Twojej procedurze, a potem kliknij „Uzbrój alarm dźwiękowy”. Od tej chwili możesz zająć się innymi zadaniami.`} />
            <Step n="2" title={`Strażnik czyta stronę co ${intervalLabel}`} text="System odczytuje depeszę wprost ze strony metar.czad.org/EPPW i porównuje widzialność oraz podstawę chmur z Twoimi progami. Wynik widzisz od razu w kolorze." />
            <Step n="3" title="Alarm → RESET → zapis" text="Gdy którakolwiek wartość przekroczy próg w dół lub w górę, rozlega się sygnał. Naciśnij RESET, by go wyciszyć. Czas zmiany i czas potwierdzenia są już w dzienniku." />
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <Rule
              tone="red"
              title="Alarm „pogorszenie” ▼"
              items={[
                `widzialność spadła z ≥ ${settings.visLimitM} m do < ${settings.visLimitM} m`,
                `podstawa chmur spadła z ≥ ${settings.cloudLimitFt} ft do < ${settings.cloudLimitFt} ft`,
                `pojawiło się VV (niebo niewidoczne) poniżej ${settings.cloudLimitFt} ft`,
              ]}
            />
            <Rule
              tone="green"
              title="Alarm „poprawa” ▲"
              items={[
                `widzialność wzrosła z < ${settings.visLimitM} m do ≥ ${settings.visLimitM} m (w tym CAVOK)`,
                `podstawa chmur wzrosła z < ${settings.cloudLimitFt} ft do ≥ ${settings.cloudLimitFt} ft`,
                "chmury poniżej progu ustąpiły (NSC, SKC, CAVOK)",
              ]}
            />
          </div>
          <p className="mt-4 text-sm text-slate-500">
            Alarm uruchamia się tylko przy <b>zmianie stanu</b> — jeśli warunki utrzymują się poniżej progu przez kilka godzin, sygnał nie powtarza się przy każdym odczycie. Grupy prognozy (TEMPO, BECMG) nie są brane pod uwagę.
          </p>
        </section>

        {/* ŹRÓDŁO DANYCH */}
        <section id="zrodlo" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12">
          <SectionHead
            kicker="Źródło danych"
            title="Depesza czytana prosto ze strony — kilkoma kanałami naraz"
            text="Serwer metar.czad.org nie udostępnia API ani nie pozwala przeglądarce pobrać strony bezpośrednio (brak nagłówków CORS). Dlatego Strażnik odczytuje HTML strony przez niezależne kanały: pierwszy startuje natychmiast, kolejne dołączają co 2,5 s albo od razu po błędzie poprzedniego. Wygrywa pierwszy świeży odczyt, reszta jest przerywana. Każdy kanał ma wyłączony cache, a odczyt starszy niż już znany jest odrzucany."
          />
          <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-bold">Kanały odczytu — ostatnia próba</h3>
                <button onClick={forceRefresh} disabled={loading} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/5 disabled:opacity-50">
                  {loading ? "Trwa odczyt…" : "Testuj teraz"}
                </button>
              </div>
              <ul className="divide-y divide-white/5">
                {statuses.length === 0 && <li className="py-3 text-sm text-slate-500">Jeszcze nie próbowano.</li>}
                {statuses.map((s) => <ReaderRow key={s.id} s={s} />)}
              </ul>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <h3 className="font-bold">Własny kanał (opcjonalnie)</h3>
              <p className="mt-2 text-sm text-slate-400">
                Jeśli masz własny serwer pośredniczący (np. Cloudflare Worker), który zwraca HTML podanego adresu z nagłówkiem CORS, wpisz go tutaj.
                Będzie używany jako pierwszy. Użyj <code className="rounded bg-slate-800 px-1">{"{url}"}</code> w miejscu adresu strony źródłowej.
              </p>
              <input
                value={customProxy}
                onChange={(e) => setCustomProxyInput(e.target.value)}
                placeholder="https://moj-proxy.example.workers.dev/?url={url}"
                className="mt-3 w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2.5 font-mono text-sm text-slate-200 outline-none focus:border-amber-400"
              />
              <div className="mt-3 flex gap-2">
                <button onClick={saveCustomProxy} className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-slate-950 hover:bg-slate-200">Zapisz i odczytaj</button>
                {getCustomProxy() && (
                  <button onClick={() => { setCustomProxyInput(""); setCustomProxy(""); nextFetchRef.current = 0; }} className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/5">Usuń</button>
                )}
              </div>
              <p className="mt-4 text-xs text-slate-500">
                Odczytywany element strony: <code className="rounded bg-slate-800 px-1">&lt;p id="EPPW-source"&gt;</code> oraz pola WIDZIALNOŚĆ, CHMURY i POMIAR z tabeli „Depesza”.
              </p>
            </div>
          </div>
        </section>

        {/* TEST */}
        <section className="mx-auto max-w-6xl px-4 py-12">
          <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 to-slate-950 p-6 sm:p-8">
            <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr] lg:items-center">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">Test przed zmianą</p>
                <h3 className="mt-2 text-2xl font-black">Sprawdź, czy alarm Cię obudzi</h3>
                <p className="mt-2 text-slate-400">Wklej przykładową depeszę i zobacz, jak zareaguje system przy obecnych progach ({visLabel} / {cloudLabel}). Wpisy testowe są oznaczone w dzienniku etykietą „TEST”. Kolejny odczyt prawdziwej strony przywróci rzeczywisty stan.</p>
              </div>
              <div className="space-y-3">
                <input value={sim} onChange={(e) => setSim(e.target.value.toUpperCase())} className="w-full rounded-xl border border-white/15 bg-slate-950 px-4 py-3 font-mono text-amber-200 outline-none focus:border-amber-400" />
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => { unlockAudio(); setArmed(true); process(sim, true); }} className="rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300">Symuluj depeszę</button>
                  <button onClick={() => setSim("EPPW 171400Z 24008KT 2500 BR BKN002 08/07 Q1012")} className="rounded-xl border border-white/15 px-3 py-2.5 text-xs hover:bg-white/5">przykład: mgła</button>
                  <button onClick={() => setSim("EPPW 171430Z 24010KT 9999 SCT015 10/06 Q1013")} className="rounded-xl border border-white/15 px-3 py-2.5 text-xs hover:bg-white/5">przykład: poprawa</button>
                  <button onClick={() => { unlockAudio(); startAlarm(); setAlarm([{ id: "test", detectedAt: new Date().toISOString(), metarTime: "TEST", param: "VIS", direction: "down", value: "test dźwięku", raw: "", visLimitM: settings.visLimitM, cloudLimitFt: settings.cloudLimitFt }]); }} className="rounded-xl border border-white/15 px-3 py-2.5 text-xs hover:bg-white/5">🔊 tylko test dźwięku</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-12">
          <SectionHead kicker="FAQ" title="Najczęstsze pytania" />
          <div className="space-y-3">
            <Faq q="Skąd pochodzą dane?" a="Wprost ze strony metar.czad.org/EPPW — tej samej, którą widzisz w przeglądarce. Strażnik odczytuje jej HTML (element z depeszą oraz zdekodowane pola) i samodzielnie wylicza widzialność oraz podstawę chmur z surowej depeszy. Nie korzysta z żadnego API." />
            <Faq q="Jak zmienić progi 3 km i 300 ft?" a={`W sekcji „Ustawienia” pod monitorem. Próg widzialności podajesz w metrach (50–9999), próg podstawy chmur w stopach (50–5000). Możesz też wybrać gotową wartość jednym kliknięciem. Obecnie obowiązuje ${visLabel} i ${cloudLabel}.`} />
            <Faq q="Czy zmiana progu wywoła alarm?" a="Nie. Po zapisaniu ustawień bieżące warunki są porównywane z nowymi progami i zapamiętywane jako nowy stan odniesienia, więc syrena nie zabrzmi od samego przestawienia wartości. Jeśli przy nowym progu warunki są już poniżej, monitor po prostu zmieni kolor na czerwony, a alarm zabrzmi dopiero przy następnym przejściu przez próg. Sama zmiana zostaje odnotowana w dzienniku." />
            <Faq q="Jak często strona może być odczytywana?" a={`Od 1 do 60 minut — ustawiasz w sekcji „Ustawienia”, obecnie co ${intervalLabel}. Skrócenie odstępu działa natychmiast: jeśli od ostatniego odczytu minęło już więcej czasu niż nowy odstęp, kolejny odczyt rusza od razu. Przy bardzo częstym odczycie publiczne czytniki stron mogą zacząć odmawiać — wtedy wydłuż odstęp lub podłącz własny kanał.`} />
            <Faq q="Który czas mam zapisać — wykrycia czy depeszy?" a="W dzienniku masz oba. „Czas METAR” to moment obserwacji meteorologicznej (oficjalny czas zmiany warunków). „Wykryto” to chwila, w której system zauważył nową depeszę. „RESET” to moment, w którym potwierdziłeś alarm. Przy każdym wpisie zapisany jest też próg, który wtedy obowiązywał." />
            <Faq q="Co liczy się jako podstawa chmur?" a="Domyślnie pułap: najniższa warstwa BKN (5–7/8) lub OVC (8/8) albo widzialność pionowa VV. Jeśli Twoja procedura wymaga uwzględnienia również FEW i SCT, przełącz to w sekcji „Ustawienia”." />
            <Faq q="Czy muszę trzymać stronę na wierzchu?" a="Nie. Karta może działać w tle — dźwięk zostanie odtworzony, a tytuł karty zacznie migać. Nie zamykaj jednak karty i nie usypiaj komputera. Jeśli zezwolisz na powiadomienia, dostaniesz też komunikat systemowy." />
            <Faq q="Co się stanie po odświeżeniu strony?" a="Ustawienia, dziennik, ostatni znany stan i czas ostatniej depeszy zostają zapamiętane w przeglądarce. Jeśli w czasie przerwy warunki się zmieniły, alarm uruchomi się zaraz po pierwszym odczycie." />
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-xs text-slate-500 sm:flex-row sm:justify-between">
          <p>EPPW Strażnik Minimów · progi {visLabel} / {cloudLabel}, odczyt co {intervalLabel}. Dane: metar.czad.org.</p>
          <p>Nie stanowi oficjalnego źródła informacji meteorologicznej. Decyzje operacyjne podejmuj na podstawie oficjalnych serwisów.</p>
        </div>
      </footer>
    </div>
  );
}

function ReaderRow({ s }: { s: ReaderStatus }) {
  const map: Record<ReaderStatus["state"], { dot: string; label: string; text: string }> = {
    idle: { dot: "bg-slate-600", label: "nieużyty", text: "text-slate-500" },
    running: { dot: "bg-amber-400 animate-pulse", label: "czyta…", text: "text-amber-300" },
    ok: { dot: "bg-emerald-400", label: "OK", text: "text-emerald-300" },
    stale: { dot: "bg-amber-500", label: "starsza kopia", text: "text-amber-300" },
    error: { dot: "bg-red-500", label: "błąd", text: "text-red-300" },
    skipped: { dot: "bg-slate-600", label: "przerwany (inny kanał był szybszy)", text: "text-slate-500" },
  };
  const m = map[s.state];
  return (
    <li className="flex items-start gap-3 py-2.5 text-sm">
      <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", m.dot)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{s.name}</span>
          {s.note && <span className="truncate text-xs text-slate-500">{s.note}</span>}
        </div>
        <div className={cn("text-xs", m.text)}>
          {m.label}
          {s.ms !== undefined && s.state !== "idle" && ` · ${(s.ms / 1000).toFixed(1)} s`}
          {s.message && s.state !== "skipped" && ` · ${s.message}`}
        </div>
      </div>
    </li>
  );
}

function StatusPill({ below, alarm, ready }: { below: boolean; alarm: boolean; ready: boolean }) {
  const label = alarm ? "ALARM" : !ready ? "ŁĄCZENIE" : below ? "PONIŻEJ" : "POWYŻEJ";
  return (
    <span className={cn("flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold tracking-wider",
      alarm ? "bg-red-600 text-white" : !ready ? "bg-slate-800 text-slate-400" : below ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300")}>
      <span className={cn("h-2 w-2 rounded-full", alarm ? "animate-ping bg-white" : !ready ? "bg-slate-500" : below ? "bg-red-400" : "bg-emerald-400")} />
      {label}
    </span>
  );
}

function HeroStat({ label, value, sub, href }: { label: string; value: string; sub: string; href?: string }) {
  const inner = (
    <>
      <p className="text-xs uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-black text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{sub}</p>
    </>
  );
  const cls = "block rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-colors";
  return href ? <a href={href} className={cn(cls, "hover:border-amber-400/40 hover:bg-amber-400/[0.06]")}>{inner}</a> : <div className={cls}>{inner}</div>;
}

function SectionHead({ kicker, title, text }: { kicker: string; title: string; text?: string }) {
  return (
    <div className="mb-8">
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">{kicker}</p>
      <h2 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">{title}</h2>
      {text && <p className="mt-3 max-w-3xl text-slate-400">{text}</p>}
    </div>
  );
}

function Gauge({ title, value, limit, state, ratio, mark }: { title: string; value: string; limit: string; state: boolean | null; ratio: number; mark: number }) {
  const markPct = Math.min(96, Math.max(4, mark * 100));
  return (
    <div className={cn("rounded-2xl border p-5", state === null ? "border-white/10" : state ? "border-red-500/40 bg-red-500/[0.07]" : "border-emerald-500/30 bg-emerald-500/[0.05]")}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-slate-400">{title}</p>
        <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", state === null ? "bg-slate-800 text-slate-400" : state ? "bg-red-500 text-white" : "bg-emerald-500 text-slate-950")}>
          {state === null ? "brak danych" : state ? "▼ PONIŻEJ" : "▲ POWYŻEJ"}
        </span>
      </div>
      <p className="mt-2 text-4xl font-black tabular-nums sm:text-5xl">{value}</p>
      <div className="relative mt-5 h-2.5 rounded-full bg-slate-800">
        <div className={cn("h-full rounded-full transition-all duration-700", state ? "bg-red-500" : "bg-emerald-500")} style={{ width: `${Math.max(2, ratio * 100)}%` }} />
        <div className="absolute -top-1.5 h-5 w-0.5 bg-amber-400 transition-all duration-500" style={{ left: `${markPct}%` }} />
      </div>
      <div className="relative mt-2 h-4">
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-xs text-amber-400/80 transition-all duration-500" style={{ left: `${markPct}%` }}>{limit}</span>
      </div>
    </div>
  );
}

function Step({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-400 font-black text-slate-950">{n}</span>
      <h3 className="mt-4 text-lg font-bold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{text}</p>
    </div>
  );
}

function Rule({ tone, title, items }: { tone: "red" | "green"; title: string; items: string[] }) {
  return (
    <div className={cn("rounded-2xl border p-6", tone === "red" ? "border-red-500/30 bg-red-500/[0.05]" : "border-emerald-500/30 bg-emerald-500/[0.05]")}>
      <h3 className={cn("text-lg font-bold", tone === "red" ? "text-red-300" : "text-emerald-300")}>{title}</h3>
      <ul className="mt-3 space-y-2 text-sm text-slate-300">
        {items.map((i) => <li key={i} className="flex gap-2"><span className="text-slate-500">—</span>{i}</li>)}
      </ul>
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <details className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5 open:bg-white/[0.05]">
      <summary className="flex cursor-pointer list-none items-center justify-between font-semibold">
        {q}
        <span className="text-amber-400 transition-transform group-open:rotate-45">+</span>
      </summary>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">{a}</p>
    </details>
  );
}
