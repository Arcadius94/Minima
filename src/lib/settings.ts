import { CLOUD_LIMIT_FT, CloudMode, VIS_LIMIT_M } from "./metar";

export interface Settings {
  /** Próg widzialności w metrach — alarm, gdy widzialność < tej wartości. */
  visLimitM: number;
  /** Próg podstawy chmur w stopach — alarm, gdy podstawa < tej wartości. */
  cloudLimitFt: number;
  /** Odstęp między odczytami strony w sekundach. */
  refreshSec: number;
  /** Co liczy się jako podstawa chmur. */
  cloudMode: CloudMode;
}

export const DEFAULT_SETTINGS: Settings = {
  visLimitM: VIS_LIMIT_M,
  cloudLimitFt: CLOUD_LIMIT_FT,
  refreshSec: 300,
  cloudMode: "ceiling",
};

export const BOUNDS = {
  /** 9999 m to najwyższa wartość kodowana w METAR (≥10 km), wyżej próg nigdy by nie zadziałał. */
  vis: { min: 50, max: 9999 },
  cloud: { min: 50, max: 5000 },
  refreshMin: { min: 1, max: 60 },
};

export const PRESETS = {
  vis: [1500, 3000, 5000],
  cloud: [150, 300, 1500],
  refreshMin: [1, 2, 5, 10, 15, 30],
};

const KEY = "eppw-settings-v2";
const OLD_MODE_KEY = "eppw-mode-v1";

const clampNum = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function clampSettings(s: Settings): Settings {
  return {
    visLimitM: Math.round(clampNum(Number(s.visLimitM) || DEFAULT_SETTINGS.visLimitM, BOUNDS.vis.min, BOUNDS.vis.max)),
    cloudLimitFt: Math.round(clampNum(Number(s.cloudLimitFt) || DEFAULT_SETTINGS.cloudLimitFt, BOUNDS.cloud.min, BOUNDS.cloud.max)),
    refreshSec: Math.round(clampNum(Number(s.refreshSec) || DEFAULT_SETTINGS.refreshSec, BOUNDS.refreshMin.min * 60, BOUNDS.refreshMin.max * 60)),
    cloudMode: s.cloudMode === "any" ? "any" : "ceiling",
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return clampSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } as Settings);
    const oldMode = localStorage.getItem(OLD_MODE_KEY); // migracja ze starszej wersji
    if (oldMode) return { ...DEFAULT_SETTINGS, cloudMode: JSON.parse(oldMode) === "any" ? "any" : "ceiling" };
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/* ---------- formatowanie ---------- */

export function fmtVisLimit(m: number): string {
  // w km tylko wartości "okrągłe" — inaczej pokazujemy metry, by nie zaokrąglać np. 9999 m do 10 km
  if (m >= 1000 && m % 100 === 0) {
    const km = m / 1000;
    return `${(Number.isInteger(km) ? km.toString() : km.toFixed(1)).replace(".", ",")} km`;
  }
  return `${m} m`;
}

export const fmtCloudLimit = (ft: number) => `${ft} ft`;

export function fmtInterval(sec: number): string {
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

export const cloudModeLabel = (m: CloudMode) => (m === "ceiling" ? "pułap: BKN, OVC, VV" : "każda warstwa: FEW, SCT, BKN, OVC, VV");

/* ---------- edycja i walidacja ---------- */

export interface Draft {
  vis: string;
  cloud: string;
  refresh: string; // w minutach
  cloudMode: CloudMode;
}

export type DraftErrors = Partial<Record<"vis" | "cloud" | "refresh", string>>;

export const toDraft = (s: Settings): Draft => ({
  vis: String(s.visLimitM),
  cloud: String(s.cloudLimitFt),
  refresh: String(s.refreshSec / 60),
  cloudMode: s.cloudMode,
});

const parseNum = (s: string): number | null => {
  const t = s.trim().replace(",", ".").replace(/\s/g, "");
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function validateDraft(d: Draft): { values: Settings | null; errors: DraftErrors } {
  const errors: DraftErrors = {};

  const vis = parseNum(d.vis);
  if (vis === null) errors.vis = "Wpisz liczbę całkowitą w metrach, np. 3000.";
  else if (!Number.isInteger(vis)) errors.vis = "Podaj pełne metry, bez części dziesiętnych.";
  else if (vis < BOUNDS.vis.min) errors.vis = `Minimalny próg to ${BOUNDS.vis.min} m.`;
  else if (vis > BOUNDS.vis.max) errors.vis = `Maksymalny próg to ${BOUNDS.vis.max} m — METAR koduje widzialność ≥10 km jako 9999 lub CAVOK.`;

  const cloud = parseNum(d.cloud);
  if (cloud === null) errors.cloud = "Wpisz liczbę całkowitą w stopach, np. 300.";
  else if (!Number.isInteger(cloud)) errors.cloud = "Podaj pełne stopy, bez części dziesiętnych.";
  else if (cloud < BOUNDS.cloud.min) errors.cloud = `Minimalny próg to ${BOUNDS.cloud.min} ft.`;
  else if (cloud > BOUNDS.cloud.max) errors.cloud = `Maksymalny próg to ${BOUNDS.cloud.max} ft.`;

  const refresh = parseNum(d.refresh);
  if (refresh === null) errors.refresh = "Wpisz liczbę minut, np. 5.";
  else if (!Number.isInteger(refresh)) errors.refresh = "Podaj pełne minuty, np. 5.";
  else if (refresh < BOUNDS.refreshMin.min) errors.refresh = `Najkrótszy odstęp to ${BOUNDS.refreshMin.min} min.`;
  else if (refresh > BOUNDS.refreshMin.max) errors.refresh = `Najdłuższy odstęp to ${BOUNDS.refreshMin.max} min.`;

  if (Object.keys(errors).length) return { values: null, errors };
  return {
    values: { visLimitM: vis!, cloudLimitFt: cloud!, refreshSec: refresh! * 60, cloudMode: d.cloudMode },
    errors,
  };
}

/** Podpowiedzi niewstrzymujące zapisu. */
export function warningsFor(s: Settings): string[] {
  const out: string[] = [];
  if (s.refreshSec <= 60) out.push("Odczyt co minutę bywa ograniczany przez publiczne czytniki stron — jeśli zobaczysz błędy, wydłuż odstęp.");
  if (s.refreshSec >= 20 * 60) out.push(`Przy odstępie ${fmtInterval(s.refreshSec)} alarm może pojawić się nawet ${fmtInterval(s.refreshSec)} po publikacji depeszy.`);
  if (s.visLimitM >= 9000) out.push("Tak wysoki próg widzialności będzie przekraczany bardzo często — spodziewaj się wielu alarmów.");
  if (s.cloudMode === "any") out.push("Liczysz każdą warstwę chmur — pojedyncze FEW/SCT nisko nad ziemią też wywołają alarm.");
  return out;
}

export function describeChanges(prev: Settings, next: Settings): string[] {
  const out: string[] = [];
  if (prev.visLimitM !== next.visLimitM) out.push(`próg widzialności ${fmtVisLimit(prev.visLimitM)} → ${fmtVisLimit(next.visLimitM)}`);
  if (prev.cloudLimitFt !== next.cloudLimitFt) out.push(`próg podstawy chmur ${fmtCloudLimit(prev.cloudLimitFt)} → ${fmtCloudLimit(next.cloudLimitFt)}`);
  if (prev.refreshSec !== next.refreshSec) out.push(`odczyt strony co ${fmtInterval(prev.refreshSec)} → co ${fmtInterval(next.refreshSec)}`);
  if (prev.cloudMode !== next.cloudMode) out.push(`liczenie chmur: ${cloudModeLabel(prev.cloudMode)} → ${cloudModeLabel(next.cloudMode)}`);
  return out;
}

export const sameSettings = (a: Settings, b: Settings) =>
  a.visLimitM === b.visLimitM && a.cloudLimitFt === b.cloudLimitFt && a.refreshSec === b.refreshSec && a.cloudMode === b.cloudMode;
