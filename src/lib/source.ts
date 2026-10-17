import { parseMetar } from "./metar";

/** Strona źródłowa — depesza jest odczytywana bezpośrednio z jej HTML. */
export const SOURCE_URL = "https://metar.czad.org/EPPW";
const ENC = encodeURIComponent(SOURCE_URL);

export type ReaderState = "idle" | "running" | "ok" | "stale" | "error" | "skipped";

export interface ReaderStatus {
  id: string;
  name: string;
  note?: string;
  state: ReaderState;
  ms?: number;
  message?: string;
  at?: number;
}

export interface PageReading {
  /** Znormalizowana depesza zaczynająca się od "EPPW ddhhmmZ" */
  raw: string;
  type: "METAR" | "SPECI";
  /** Zdekodowane pola odczytane ze strony, np. WIDZIALNOŚĆ, CHMURY, POMIAR */
  decoded: Record<string, string>;
  /** Nagłówek strony, np. "17 października 2026, 13:30 UTC / 15:30 CEST" */
  headerTime?: string;
  via: string;
  ms: number;
  fetchedAt: number;
}

interface Reader {
  id: string;
  name: string;
  note?: string;
  kind: "html" | "json";
  url: () => string;
  headers?: Record<string, string>;
}

const CUSTOM_KEY = "eppw-custom-proxy";
export const getCustomProxy = () => localStorage.getItem(CUSTOM_KEY) ?? "";
export const setCustomProxy = (v: string) => (v.trim() ? localStorage.setItem(CUSTOM_KEY, v.trim()) : localStorage.removeItem(CUSTOM_KEY));

/**
 * Kanały odczytu strony. Serwer metar.czad.org nie wysyła nagłówków CORS, więc przeglądarka
 * nie może pobrać HTML bezpośrednio — każdy kanał to publiczny "czytnik stron", który zwraca
 * oryginalny HTML. Parametry disableCache / x-no-cache wymuszają świeży odczyt za każdym razem.
 */
export function buildReaders(): Reader[] {
  const list: Reader[] = [];
  const custom = getCustomProxy().trim();
  if (custom) {
    list.push({
      id: "custom",
      name: "własny czytnik",
      note: custom,
      kind: "html",
      url: () => (custom.includes("{url}") ? custom.replace("{url}", ENC) : custom + ENC),
    });
  }
  list.push(
    {
      id: "jina",
      name: "r.jina.ai",
      note: "renderuje stronę i zwraca jej HTML, bez cache",
      kind: "html",
      url: () => `https://r.jina.ai/${SOURCE_URL}`,
      headers: { "x-no-cache": "true", "x-return-format": "html" },
    },
    {
      id: "hexlet",
      name: "allorigins.hexlet.app",
      note: "kopia strony 1:1, cache wyłączony",
      kind: "html",
      url: () => `https://allorigins.hexlet.app/raw?url=${ENC}&disableCache=true&_=${Date.now()}`,
    },
    {
      id: "allorigins",
      name: "api.allorigins.win",
      note: "kopia strony 1:1, cache wyłączony",
      kind: "html",
      url: () => `https://api.allorigins.win/raw?url=${ENC}&disableCache=true&_=${Date.now()}`,
    },
    {
      id: "allorigins-json",
      name: "api.allorigins.win (JSON)",
      note: "ta sama usługa, inna ścieżka",
      kind: "json",
      url: () => `https://api.allorigins.win/get?url=${ENC}&disableCache=true&_=${Date.now()}`,
    },
    {
      id: "codetabs",
      name: "api.codetabs.com",
      note: "zapasowy",
      kind: "html",
      url: () => `https://api.codetabs.com/v1/proxy/?quest=${ENC}`,
    },
    {
      id: "corsfix",
      name: "proxy.corsfix.com",
      note: "działa tylko gdy strona jest uruchomiona z localhost",
      kind: "html",
      url: () => `https://proxy.corsfix.com/?${SOURCE_URL}`,
    },
    {
      id: "corslol",
      name: "api.cors.lol",
      note: "zapasowy, limitowany",
      kind: "html",
      url: () => `https://api.cors.lol/?url=${ENC}`,
    },
  );
  return list;
}

const clean = (s: string) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").replace(/=+$/, "").trim();

/** Wyciąga depeszę i zdekodowane pola z HTML strony metar.czad.org/EPPW. */
export function extractReading(text: string, kind: "html" | "json"): Omit<PageReading, "via" | "ms" | "fetchedAt"> | null {
  let html = text;
  if (kind === "json") {
    try {
      html = (JSON.parse(text) as { contents?: string }).contents ?? "";
    } catch {
      return null;
    }
  }
  if (!html) return null;

  const doc = new DOMParser().parseFromString(html, "text/html");

  // 1) Element z depeszą na stronie: <p id="EPPW-source">EPPW 171330Z ...</p>
  let line = clean(doc.querySelector("#EPPW-source, .report-source-line")?.textContent ?? "");

  // 2) Awaryjnie: szukaj wzorca depeszy w tekście całej strony
  if (!/EPPW\s+\d{6}Z/.test(line)) {
    const body = doc.body?.textContent ?? html;
    const m = body.match(/(?:(?:METAR|SPECI|COR)\s+){0,2}EPPW\s+\d{6}Z[^\n=<]{0,220}/);
    if (!m) return null;
    line = clean(m[0]);
  }

  const type: PageReading["type"] = /\bSPECI\b/.test(line.split("EPPW")[0]) ? "SPECI" : "METAR";
  const raw = line.replace(/^(?:(?:METAR|SPECI|COR)\s+)+/, "");
  if (!/^EPPW\s+\d{6}Z/.test(raw)) return null;

  const decoded: Record<string, string> = {};
  doc.querySelectorAll("dt").forEach((dt) => {
    const dd = dt.nextElementSibling;
    const k = clean(dt.textContent ?? "").toUpperCase();
    const v = clean(dd?.textContent ?? "");
    if (dd?.tagName === "DD" && k && v) decoded[k] = v;
  });
  const headerTime = clean(doc.querySelector(".panel-title")?.textContent ?? "") || undefined;

  return { raw, type, decoded, headerTime };
}

export class ReadError extends Error {
  /** `stale` = przynajmniej jeden kanał odczytał stronę, ale pokazywała starszą depeszę niż już znana (żaden nie zwrócił świeżej). */
  constructor(message: string, public statuses: ReaderStatus[], public stale: boolean) {
    super(message);
  }
}

export interface ReadOptions {
  /** Czas (ms) ostatnio zaakceptowanej obserwacji — starsze kopie strony są odrzucane jako "stale". */
  minObsTime?: number | null;
  onStatus?: (statuses: ReaderStatus[]) => void;
  /** Odstęp między uruchamianiem kolejnych kanałów (ms). */
  stagger?: number;
  perReaderTimeout?: number;
}

const friendly = (e: unknown) => {
  const err = e as Error;
  if (err?.name === "AbortError") return "przekroczono czas oczekiwania";
  if (/Failed to fetch|NetworkError|Load failed/i.test(err?.message ?? "")) return "brak odpowiedzi (sieć / CORS)";
  return err?.message || "nieznany błąd";
};

/**
 * Odczyt strony z "zabezpieczeniem": pierwszy kanał startuje od razu, kolejne co `stagger` ms
 * (lub natychmiast po błędzie poprzedniego). Wygrywa pierwszy poprawny i świeży odczyt,
 * pozostałe żądania są przerywane.
 */
export function readSourcePage(opts: ReadOptions = {}): Promise<PageReading> {
  const readers = buildReaders();
  const stagger = opts.stagger ?? 2500;
  const perTimeout = opts.perReaderTimeout ?? 20000;
  const statuses: ReaderStatus[] = readers.map((r) => ({ id: r.id, name: r.name, note: r.note, state: "idle" }));
  const emit = () => opts.onStatus?.(statuses.map((s) => ({ ...s })));
  const controllers: AbortController[] = [];
  let settled = false;
  let launched = 0;
  let finished = 0;

  emit();

  return new Promise<PageReading>((resolve, reject) => {
    const finishIfAllDone = () => {
      if (settled || finished < readers.length) return;
      settled = true;
      const stale = statuses.some((s) => s.state === "stale");
      reject(
        new ReadError(
          statuses.map((s) => `${s.name}: ${s.message ?? s.state}`).join(" · "),
          statuses.map((s) => ({ ...s })),
          stale,
        ),
      );
    };

    const launchNext = () => {
      if (settled || launched >= readers.length) return;
      const i = launched++;
      const r = readers[i];
      const st = statuses[i];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      st.state = "running";
      st.at = Date.now();
      emit();
      const t0 = performance.now();
      const timer = setTimeout(() => ctrl.abort(), perTimeout);

      fetch(r.url(), { signal: ctrl.signal, cache: "no-store", headers: r.headers })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((text) => {
          const reading = extractReading(text, r.kind);
          if (!reading) throw new Error("nie znaleziono depeszy w odczytanej stronie");
          const parsed = parseMetar(reading.raw);
          st.ms = Math.round(performance.now() - t0);
          if (opts.minObsTime && parsed.obsDate && parsed.obsDate.getTime() < opts.minObsTime) {
            st.state = "stale";
            st.message = `starsza kopia strony (${parsed.obsTime})`;
            emit();
            launchNext();
            return;
          }
          st.state = "ok";
          st.message = `${reading.type} ${parsed.obsTime ?? ""}`.trim();
          emit();
          if (!settled) {
            settled = true;
            controllers.forEach((c) => c !== ctrl && c.abort());
            resolve({ ...reading, via: r.name, ms: st.ms, fetchedAt: Date.now() });
          }
        })
        .catch((e) => {
          st.ms = Math.round(performance.now() - t0);
          if (settled) {
            if (st.state === "running") st.state = "skipped";
            emit();
            return;
          }
          st.state = "error";
          st.message = friendly(e);
          emit();
          launchNext();
        })
        .finally(() => {
          clearTimeout(timer);
          finished++;
          finishIfAllDone();
        });
    };

    launchNext();
    const ticker = setInterval(() => {
      if (settled || launched >= readers.length) {
        clearInterval(ticker);
        return;
      }
      launchNext();
    }, stagger);
  });
}
