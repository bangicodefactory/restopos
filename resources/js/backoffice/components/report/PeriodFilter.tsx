/**
 * The date-range + register filter shared by `Reports/SalesDetails` and `Reports/OrderAnalytics`.
 *
 * Both report controllers validate the same three parameters — `from`, `to`, `config_id` — and
 * both default the range server-side when it is omitted (start of month for sales details, the
 * last thirty days for analytics). The filter therefore always renders the range the *server*
 * echoed back, never a client-side guess, so what is on screen is what was queried.
 *
 * The presets are ordinary buttons that set both dates at once: an operator asking "et hier ?"
 * should not have to open two date pickers and count backwards. `todayIso` comes from
 * `lib/format` so the browser's zone decides what "today" is, which is the same zone the operator
 * is standing in.
 *
 * **Contract gap:** neither report page is sent a list of registers, so the register filter is a
 * numeric id with the reason attached rather than a select that would have to invent its options.
 */

import { Button, FOCUS_RING, cn } from '@shared/ui';
import { type JSX } from 'react';

import { useT } from '../../i18n';
import { todayIso } from '../../lib/format';

export type PeriodValue = {
    from: string;
    to: string;
    configId: string;
};

export type PeriodFilterProps = {
    value: PeriodValue;
    onChange: (value: PeriodValue) => void;
    onApply: () => void;
    processing?: boolean;
    /** Extra controls (a session picker, an export button) rendered at the end of the bar. */
    children?: JSX.Element | null;
};

const FIELD = 'min-h-touch rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-300';

/** `[label, from, to]` — computed from the browser's zone, not the server's. */
function presets(t: (key: 'report.presetToday' | 'report.presetWeek' | 'report.presetMonth' | 'report.preset30') => string): {
    id: string;
    label: string;
    from: string;
    to: string;
}[] {
    const today = todayIso();
    const startOfMonth = `${today.slice(0, 7)}-01`;
    return [
        { id: 'today', label: t('report.presetToday'), from: today, to: today },
        { id: 'week', label: t('report.presetWeek'), from: todayIso(-6), to: today },
        { id: 'month', label: t('report.presetMonth'), from: startOfMonth, to: today },
        { id: 'thirty', label: t('report.preset30'), from: todayIso(-29), to: today },
    ];
}

export function PeriodFilter({
    value,
    onChange,
    onApply,
    processing = false,
    children,
}: PeriodFilterProps): JSX.Element {
    const t = useT();

    return (
        <div className="rounded-pos-lg bg-white p-4 shadow-pos ring-1 ring-slate-200">
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600" htmlFor="report-from">
                    {t('report.from')}
                    <input
                        id="report-from"
                        type="date"
                        value={value.from}
                        max={value.to === '' ? undefined : value.to}
                        onChange={(event) => onChange({ ...value, from: event.target.value })}
                        className={cn(FIELD, FOCUS_RING)}
                    />
                </label>

                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600" htmlFor="report-to">
                    {t('report.to')}
                    <input
                        id="report-to"
                        type="date"
                        value={value.to}
                        min={value.from === '' ? undefined : value.from}
                        onChange={(event) => onChange({ ...value, to: event.target.value })}
                        className={cn(FIELD, FOCUS_RING)}
                    />
                </label>

                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600" htmlFor="report-config">
                    {t('report.config')}
                    <input
                        id="report-config"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        placeholder="id"
                        value={value.configId}
                        onChange={(event) => onChange({ ...value, configId: event.target.value })}
                        className={cn(FIELD, 'w-24 tabular-nums', FOCUS_RING)}
                    />
                </label>

                <Button size="md" loading={processing} onClick={onApply}>
                    {t('action.apply')}
                </Button>

                {children}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500">{t('report.presets')}</span>
                {presets(t).map((preset) => {
                    const active = value.from === preset.from && value.to === preset.to;
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => onChange({ ...value, from: preset.from, to: preset.to })}
                            className={cn(
                                'min-h-touch rounded-pos px-3 text-sm',
                                active
                                    ? 'bg-brand-50 font-semibold text-brand-800 ring-1 ring-inset ring-brand-200'
                                    : 'text-slate-600 hover:bg-slate-100',
                                FOCUS_RING,
                            )}
                        >
                            {preset.label}
                        </button>
                    );
                })}
            </div>

            <p className="mt-2 text-xs text-slate-500">{t('report.configIdHint')}</p>
        </div>
    );
}
