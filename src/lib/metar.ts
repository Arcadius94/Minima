export const VIS_LIMIT_M = 3000;
export const CLOUD_LIMIT_FT = 300;

export type CloudMode = "ceiling" | "any";

export interface ParsedMetar {
  raw: string;
  obsTime: string | null; // np. "17 13:30Z"
  obsDate: Date | null;
  visibilityM: number | null; // metry; 10000 = 10 km lub więcej
  cavok: boolean;
  layers: { cover: string; baseFt: number; type?: string }[];
  verticalVisFt: number | null;
  wind: string | null;
  temp: string | null;
  qnh: string | null;
}

/** Zamienia grupę ddhhmmZ na datę UTC (bieżący lub poprzedni miesiąc). */
export function obsDateFromGroup(day: number, hh: number, mm: number, now = new Date()): Date {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  // kandydaci: poprzedni / bieżący / następny miesiąc — wybieramy datę najbliższą "teraz"
  const cands = [-1, 0, 1]
    .map((k) => new Date(Date.UTC(y, mo + k, day, hh, mm)))
    .filter((d) => d.getUTCDate() === day)
    .sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()));
  return cands[0] ?? new Date(Date.UTC(y, mo, day, hh, mm));
}

export function parseMetar(raw: string): ParsedMetar {
  const tokens = raw.split(" ").filter(Boolean);
  const res: ParsedMetar = {
    raw,
    obsTime: null,
    obsDate: null,
    visibilityM: null,
    cavok: false,
    layers: [],
    verticalVisFt: null,
    wind: null,
    temp: null,
    qnh: null,
  };

  // Grupy prognozy / uwagi nie wpływają na stan bieżący
  const stopIdx = tokens.findIndex((t) => /^(TEMPO|BECMG|NOSIG|RMK|PROB\d{2})$/.test(t));
  const body = stopIdx === -1 ? tokens : tokens.slice(0, stopIdx);

  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    let m: RegExpMatchArray | null;

    if ((m = t.match(/^(\d{2})(\d{2})(\d{2})Z$/))) {
      res.obsTime = `${m[1]} ${m[2]}:${m[3]}Z`;
      res.obsDate = obsDateFromGroup(+m[1], +m[2], +m[3]);
      continue;
    }
    if (/^(\d{3}|VRB)\d{2,3}(G\d{2,3})?(KT|MPS)$/.test(t)) {
      res.wind = t;
      continue;
    }
    if (t === "CAVOK") {
      res.cavok = true;
      res.visibilityM = 10000;
      continue;
    }
    // Widzialność panująca w metrach (pierwsza grupa 4-cyfrowa)
    if (res.visibilityM === null && (m = t.match(/^(\d{4})(NDV)?$/))) {
      const v = +m[1];
      res.visibilityM = v === 9999 ? 10000 : v;
      continue;
    }
    // Mile: 10SM, 1/2SM, M1/4SM, "1 1/2SM"
    if (res.visibilityM === null && /^M?(\d+)?\/?(\d+)?SM$/.test(t)) {
      let miles = 0;
      const frac = t.replace(/^M/, "").replace("SM", "");
      if (frac.includes("/")) {
        const [a, b] = frac.split("/").map(Number);
        miles = a / b;
        const prev = body[i - 1];
        if (prev && /^\d$/.test(prev)) miles += +prev;
      } else miles = +frac;
      res.visibilityM = Math.round(miles * 1609);
      continue;
    }
    if ((m = t.match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU|\/\/\/)?$/))) {
      res.layers.push({ cover: m[1], baseFt: +m[2] * 100, type: m[3] && m[3] !== "///" ? m[3] : undefined });
      continue;
    }
    if ((m = t.match(/^VV(\d{3})$/))) {
      res.verticalVisFt = +m[1] * 100;
      continue;
    }
    if (/^M?\d{2}\/M?\d{2}$/.test(t)) {
      res.temp = t.replace(/M/g, "-");
      continue;
    }
    if ((m = t.match(/^Q(\d{4})$/))) {
      res.qnh = m[1];
      continue;
    }
  }
  return res;
}

/** Najniższa istotna podstawa chmur w ft; null = brak istotnych chmur */
export function relevantCloudBase(p: ParsedMetar, mode: CloudMode): number | null {
  const candidates: number[] = [];
  if (p.verticalVisFt !== null) candidates.push(p.verticalVisFt);
  for (const l of p.layers) {
    if (mode === "any" || l.cover === "BKN" || l.cover === "OVC") candidates.push(l.baseFt);
  }
  return candidates.length ? Math.min(...candidates) : null;
}

export interface Evaluation {
  visBelow: boolean | null;
  cloudBelow: boolean | null;
  cloudBaseFt: number | null;
}

/** Progi alarmowe — konfigurowalne przez użytkownika. */
export interface Thresholds {
  visLimitM: number;
  cloudLimitFt: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { visLimitM: VIS_LIMIT_M, cloudLimitFt: CLOUD_LIMIT_FT };

export function evaluate(p: ParsedMetar, mode: CloudMode, th: Thresholds = DEFAULT_THRESHOLDS): Evaluation {
  const cloudBaseFt = relevantCloudBase(p, mode);
  return {
    visBelow: p.visibilityM === null ? null : p.visibilityM < th.visLimitM,
    cloudBelow: cloudBaseFt === null ? false : cloudBaseFt < th.cloudLimitFt,
    cloudBaseFt,
  };
}
