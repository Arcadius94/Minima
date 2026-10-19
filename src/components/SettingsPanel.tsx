import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  BOUNDS,
  DEFAULT_SETTINGS,
  Draft,
  PRESETS,
  Settings,
  cloudModeLabel,
  fmtCloudLimit,
  fmtInterval,
  fmtVisLimit,
  sameSettings,
  toDraft,
  validateDraft,
  warningsFor,
} from "../lib/settings";
import { CloudMode } from "../lib/metar";
import { cn } from "../utils/cn";

interface Props {
  settings: Settings;
  onApply: (s: Settings) => void;
}

export default function SettingsPanel({ settings, onApply }: Props) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => setDraft(toDraft(settings)), [settings]);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const { values, errors } = useMemo(() => validateDraft(draft), [draft]);
  const textDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(settings)), [draft, settings]);
  const valid = values !== null;
  // zapis tylko wtedy, gdy wartości faktycznie różnią się od zapisanych (np. "03000" ≡ "3000")
  const canSave = !!values && !sameSettings(values, settings);
  const warnings = values ? warningsFor(values) : [];
  const isDefault = sameSettings(settings, DEFAULT_SETTINGS);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    if (!values || !canSave) {
      if (values) setDraft(toDraft(settings)); // normalizacja zapisu tej samej wartości
      return;
    }
    onApply(values);
    const msg = `Zapisano ${new Date().toLocaleTimeString("pl-PL")} · stan odniesienia przeliczony, harmonogram odczytów zaktualizowany.`;
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 8000);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") setDraft(toDraft(settings));
  };

  const preview = values ?? settings;

  return (
    <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-5 sm:p-7" onKeyDown={onKeyDown}>
      <div className="grid gap-5 lg:grid-cols-3">
        <NumField
          label="Próg widzialności"
          unit="m"
          value={draft.vis}
          onChange={(v) => set({ vis: v })}
          error={errors.vis}
          hint={`Zakres ${BOUNDS.vis.min}–${BOUNDS.vis.max} m. Alarm, gdy widzialność spadnie poniżej tej wartości lub wróci powyżej niej.`}
          presets={PRESETS.vis.map((p) => ({ value: String(p), label: fmtVisLimit(p) }))}
          current={draft.vis}
        />
        <NumField
          label="Próg podstawy chmur"
          unit="ft"
          value={draft.cloud}
          onChange={(v) => set({ cloud: v })}
          error={errors.cloud}
          hint={`Zakres ${BOUNDS.cloud.min}–${BOUNDS.cloud.max} ft. METAR podaje podstawę co 100 ft — próg 150 ft oznacza alarm przy podstawie 100 ft i niżej.`}
          presets={PRESETS.cloud.map((p) => ({ value: String(p), label: fmtCloudLimit(p) }))}
          current={draft.cloud}
        />
        <NumField
          label="Czas odczytu strony"
          unit="min"
          value={draft.refresh}
          onChange={(v) => set({ refresh: v })}
          error={errors.refresh}
          hint={`Zakres ${BOUNDS.refreshMin.min}–${BOUNDS.refreshMin.max} min. Co tyle Strażnik odczytuje metar.czad.org/EPPW.`}
          presets={PRESETS.refreshMin.map((p) => ({ value: String(p), label: `${p} min` }))}
          current={draft.refresh}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <label className="lg:col-span-2">
          <span className="text-sm font-semibold text-slate-200">Co liczy się jako podstawa chmur</span>
          <select
            value={draft.cloudMode}
            onChange={(e) => set({ cloudMode: e.target.value as CloudMode })}
            className="mt-2 w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none focus:border-amber-400"
          >
            <option value="ceiling">Pułap — BKN, OVC lub widzialność pionowa VV (standard operacyjny)</option>
            <option value="any">Każda warstwa — także FEW i SCT</option>
          </select>
          <span className="mt-1.5 block text-xs text-slate-500">Zmiana wpływa na to, którą warstwę porównujemy z progiem {fmtCloudLimit(preview.cloudLimitFt)}.</span>
        </label>

        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-300">Podgląd ustawień</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-200">
            Alarm zabrzmi, gdy <b>widzialność</b> przekroczy w dół lub w górę <b className="text-amber-300">{fmtVisLimit(preview.visLimitM)}</b> ({preview.visLimitM} m),
            albo gdy <b>podstawa chmur</b> ({cloudModeLabel(preview.cloudMode)}) przekroczy <b className="text-amber-300">{fmtCloudLimit(preview.cloudLimitFt)}</b>.
            Strona będzie odczytywana <b className="text-amber-300">co {fmtInterval(preview.refreshSec)}</b>.
          </p>
        </div>
      </div>

      {warnings.length > 0 && (
        <ul className="mt-4 space-y-1.5 text-xs text-amber-300/90">
          {warnings.map((w) => <li key={w}>⚠ {w}</li>)}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={!canSave}
          className="rounded-xl bg-amber-400 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Zapisz ustawienia
        </button>
        <button
          onClick={() => setDraft(toDraft(settings))}
          disabled={!textDirty}
          className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold hover:bg-white/5 disabled:opacity-40"
        >
          Anuluj zmiany
        </button>
        <button
          onClick={() => setDraft(toDraft(DEFAULT_SETTINGS))}
          disabled={JSON.stringify(draft) === JSON.stringify(toDraft(DEFAULT_SETTINGS))}
          className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold hover:bg-white/5 disabled:opacity-40"
        >
          Przywróć domyślne (3 km / 300 ft / 5 min)
        </button>

        <span className="ml-auto text-xs">
          {!valid ? (
            <span className="text-red-300">Popraw zaznaczone pola, aby zapisać.</span>
          ) : canSave ? (
            <span className="text-amber-300">Masz niezapisane zmiany — naciśnij Zapisz lub Enter.</span>
          ) : textDirty ? (
            <span className="text-slate-500">Wpisane wartości są takie same jak zapisane.</span>
          ) : (
            <span className="text-slate-500">
              Aktywne: {fmtVisLimit(settings.visLimitM)} · {fmtCloudLimit(settings.cloudLimitFt)} · co {fmtInterval(settings.refreshSec)}
              {isDefault && " (ustawienia domyślne)"}
            </span>
          )}
        </span>
      </div>

      {flash && (
        <p className="mt-4 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">✓ {flash}</p>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Zmiana progów nie wywołuje alarmu: po zapisaniu bieżące warunki są porównywane z nowymi wartościami i zapamiętywane jako stan odniesienia.
        Alarm zabrzmi dopiero przy kolejnym <b>przejściu</b> przez próg. Każda zmiana ustawień trafia też do dziennika, więc wiadomo, od której godziny obowiązywały dane progi.
        Ustawienia są zapisywane w tej przeglądarce i obowiązują po ponownym otwarciu strony.
      </p>
    </div>
  );
}

function NumField({
  label, unit, value, onChange, error, hint, presets, current,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint: string;
  presets: { value: string; label: string }[];
  current: string;
}) {
  return (
    <div>
      <label className="block">
        <span className="text-sm font-semibold text-slate-200">{label}</span>
        <span className="relative mt-2 block">
          <input
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!!error}
            className={cn(
              "w-full rounded-xl border bg-slate-950 px-3 py-2.5 pr-12 font-mono text-lg text-slate-100 outline-none",
              error ? "border-red-500/70 focus:border-red-400" : "border-white/15 focus:border-amber-400",
            )}
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-500">{unit}</span>
        </span>
      </label>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.value}
            onClick={() => onChange(p.value)}
            className={cn(
              "rounded-lg border px-2 py-1 text-xs transition-colors",
              current === p.value ? "border-amber-400 bg-amber-400/15 text-amber-300" : "border-white/10 text-slate-400 hover:bg-white/5",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : <p className="mt-2 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
