/**
 * The form kit.
 *
 * One `Field` shell owns the parts that are easy to get subtly wrong — the `<label for>`
 * association, `aria-describedby` pointing at *both* the hint and the error, `aria-invalid`, the
 * required marker — and every concrete field renders its control inside it. That is the whole
 * trick: accessibility is structural here, not something each of the two hundred inputs in this
 * app has to remember.
 *
 * Money uses `MoneyInput` from `@shared/ui`, which keeps amounts as decimal strings end to end.
 * Nothing in this file turns a monetary value into a number.
 */

import type { CurrencyFormat } from '@domain/receipt/index';
import { FOCUS_RING, MoneyInput, cn } from '@shared/ui';
import {
    useCallback,
    useId,
    useMemo,
    useRef,
    useState,
    type JSX,
    type ReactNode,
} from 'react';

import { useT } from '../../i18n';
import { EUR } from '../../lib/money';
import { normalizeSearch } from '../data-table/table-state';

// ───────────────────────────────────────────────────────────── shell

export type FieldShellProps = {
    label: ReactNode;
    hint?: ReactNode;
    error?: string;
    required?: boolean;
    /** Explains *why* a control is disabled. Rendered next to the label. */
    lockedReason?: string;
    className?: string;
    children: (bag: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
};

export function Field({
    label,
    hint,
    error,
    required,
    lockedReason,
    className,
    children,
}: FieldShellProps): JSX.Element {
    const base = useId();
    const id = `${base}-control`;
    const hintId = hint ? `${base}-hint` : undefined;
    const errorId = error ? `${base}-error` : undefined;
    const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

    return (
        <div className={cn('flex flex-col gap-1', className)}>
            <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-700">
                <span>
                    {label}
                    {required ? (
                        <span className="ms-1 text-danger" aria-hidden>
                            *
                        </span>
                    ) : null}
                </span>
                {lockedReason ? (
                    <span
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500"
                        title={lockedReason}
                    >
                        🔒
                        <span className="sr-only">{lockedReason}</span>
                    </span>
                ) : null}
            </label>

            {children({ id, describedBy, invalid: Boolean(error) })}

            {hint ? (
                <p id={hintId} className="text-xs text-slate-500">
                    {hint}
                </p>
            ) : null}
            {error ? (
                <p id={errorId} className="text-xs font-medium text-danger" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

const CONTROL =
    'min-h-touch w-full rounded-pos bg-white px-3 text-base text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500';

type Common = {
    label: ReactNode;
    hint?: ReactNode;
    error?: string;
    required?: boolean;
    disabled?: boolean;
    lockedReason?: string;
    className?: string;
};

// ───────────────────────────────────────────────────────────── text / number

export function TextField({
    value,
    onChange,
    placeholder,
    type = 'text',
    autoComplete,
    maxLength,
    ...common
}: Common & {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    type?: 'text' | 'email' | 'password' | 'url' | 'tel';
    autoComplete?: string;
    maxLength?: number;
}): JSX.Element {
    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <input
                    id={id}
                    type={type}
                    value={value}
                    placeholder={placeholder}
                    autoComplete={autoComplete}
                    maxLength={maxLength}
                    disabled={common.disabled}
                    required={common.required}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => onChange(event.target.value)}
                    className={cn(CONTROL, invalid && 'ring-danger', FOCUS_RING)}
                />
            )}
        </Field>
    );
}

export function TextareaField({
    value,
    onChange,
    rows = 4,
    placeholder,
    maxLength,
    ...common
}: Common & {
    value: string;
    onChange: (value: string) => void;
    rows?: number;
    placeholder?: string;
    maxLength?: number;
}): JSX.Element {
    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <textarea
                    id={id}
                    rows={rows}
                    value={value}
                    placeholder={placeholder}
                    maxLength={maxLength}
                    disabled={common.disabled}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => onChange(event.target.value)}
                    className={cn(CONTROL, 'py-2 leading-relaxed', invalid && 'ring-danger', FOCUS_RING)}
                />
            )}
        </Field>
    );
}

/**
 * Integers and counts — never money. `value` is a number because these are quantities
 * (seats, minutes, copies), and an empty box is `null`, not `0`: "no limit" and "zero" are
 * different answers.
 */
export function NumberField({
    value,
    onChange,
    min,
    max,
    step = 1,
    suffix,
    ...common
}: Common & {
    value: number | null;
    onChange: (value: number | null) => void;
    min?: number;
    max?: number;
    step?: number;
    suffix?: string;
}): JSX.Element {
    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <div className="relative flex items-center">
                    <input
                        id={id}
                        type="number"
                        inputMode="numeric"
                        value={value === null ? '' : String(value)}
                        min={min}
                        max={max}
                        step={step}
                        disabled={common.disabled}
                        aria-describedby={describedBy}
                        aria-invalid={invalid || undefined}
                        onChange={(event) => {
                            const raw = event.target.value;
                            if (raw === '') {
                                onChange(null);
                                return;
                            }
                            const parsed = Number(raw);
                            onChange(Number.isFinite(parsed) ? parsed : null);
                        }}
                        className={cn(
                            CONTROL,
                            'text-end tabular-nums',
                            suffix && 'pe-12',
                            invalid && 'ring-danger',
                            FOCUS_RING,
                        )}
                    />
                    {suffix ? (
                        <span className="pointer-events-none absolute end-3 text-sm text-slate-500">{suffix}</span>
                    ) : null}
                </div>
            )}
        </Field>
    );
}

/** Decimal-string money. Delegates to `@shared/ui`'s `MoneyInput`. */
export function MoneyField({
    value,
    onChange,
    currency = EUR,
    ...common
}: Common & {
    value: string;
    onChange: (value: string) => void;
    currency?: CurrencyFormat;
}): JSX.Element {
    return (
        <Field {...common}>
            {({ describedBy, invalid }) => (
                <div aria-describedby={describedBy}>
                    <MoneyInput
                        value={value}
                        onChange={onChange}
                        currency={currency}
                        size="md"
                        invalid={invalid}
                        disabled={common.disabled}
                        showPreview
                    />
                </div>
            )}
        </Field>
    );
}

// ───────────────────────────────────────────────────────────── select

export type Option = {
    value: string;
    label: string;
    disabled?: boolean;
    group?: string;
};

export function SelectField({
    value,
    onChange,
    options,
    placeholder,
    ...common
}: Common & {
    value: string;
    onChange: (value: string) => void;
    options: readonly Option[];
    placeholder?: string;
}): JSX.Element {
    const groups = useMemo(() => {
        const map = new Map<string, Option[]>();
        for (const option of options) {
            const key = option.group ?? '';
            const bucket = map.get(key);
            if (bucket) bucket.push(option);
            else map.set(key, [option]);
        }
        return [...map.entries()];
    }, [options]);

    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <select
                    id={id}
                    value={value}
                    disabled={common.disabled}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => onChange(event.target.value)}
                    className={cn(CONTROL, 'pe-8', invalid && 'ring-danger', FOCUS_RING)}
                >
                    {placeholder ? <option value="">{placeholder}</option> : null}
                    {groups.map(([group, entries]) =>
                        group === '' ? (
                            entries.map((option) => (
                                <option key={option.value} value={option.value} disabled={option.disabled}>
                                    {option.label}
                                </option>
                            ))
                        ) : (
                            <optgroup key={group} label={group}>
                                {entries.map((option) => (
                                    <option key={option.value} value={option.value} disabled={option.disabled}>
                                        {option.label}
                                    </option>
                                ))}
                            </optgroup>
                        ),
                    )}
                </select>
            )}
        </Field>
    );
}

/**
 * Multi-select as a searchable checkbox list.
 *
 * A native `<select multiple>` is unusable with a mouse (ctrl-click to deselect) and worse on a
 * tablet, and these lists — payment methods, categories, floors — routinely run past thirty
 * entries.
 */
export function MultiSelectField({
    values,
    onChange,
    options,
    height = 'h-56',
    ...common
}: Common & {
    values: readonly number[];
    onChange: (values: number[]) => void;
    options: readonly Option[];
    height?: string;
}): JSX.Element {
    const t = useT();
    const [query, setQuery] = useState('');

    const filtered = useMemo(() => {
        const needle = normalizeSearch(query);
        if (needle === '') return options;
        return options.filter((option) => normalizeSearch(option.label).includes(needle));
    }, [options, query]);

    const toggle = useCallback(
        (raw: string, checked: boolean) => {
            const id = Number(raw);
            if (!Number.isFinite(id)) return;
            onChange(checked ? [...new Set([...values, id])] : values.filter((value) => value !== id));
        },
        [onChange, values],
    );

    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <div
                    id={id}
                    aria-describedby={describedBy}
                    className={cn(
                        'rounded-pos ring-1 ring-inset ring-slate-300',
                        invalid && 'ring-danger',
                        common.disabled && 'bg-slate-50 opacity-70',
                    )}
                >
                    <div className="border-b border-slate-200 p-2">
                        <input
                            type="search"
                            value={query}
                            placeholder={t('form.searchOption')}
                            disabled={common.disabled}
                            onChange={(event) => setQuery(event.target.value)}
                            className={cn(
                                'min-h-touch w-full rounded-pos bg-white px-3 text-sm ring-1 ring-inset ring-slate-200',
                                FOCUS_RING,
                            )}
                        />
                    </div>

                    <div role="group" aria-label={typeof common.label === 'string' ? common.label : undefined} className={cn('overflow-auto p-1', height)}>
                        {filtered.length === 0 ? (
                            <p className="px-2 py-3 text-sm text-slate-500">{t('form.noOption')}</p>
                        ) : (
                            filtered.map((option) => {
                                const numeric = Number(option.value);
                                const checked = values.includes(numeric);
                                return (
                                    <label
                                        key={option.value}
                                        className="flex min-h-touch cursor-pointer items-center gap-2 rounded-pos px-2 text-sm hover:bg-slate-50"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={common.disabled || option.disabled}
                                            onChange={(event) => toggle(option.value, event.target.checked)}
                                            className={cn('h-4 w-4 rounded border-slate-300', FOCUS_RING)}
                                        />
                                        <span className="truncate">{option.label}</span>
                                    </label>
                                );
                            })
                        )}
                    </div>

                    <div className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500">
                        {t('form.selectedCount', { count: values.length })}
                    </div>
                </div>
            )}
        </Field>
    );
}

/**
 * Single relation picker: a searchable combobox over `{id, name}` options.
 *
 * Used where a `<select>` would be unreadable — "linked to table", "parent category",
 * "base pricelist" — and where `null` is a legitimate value.
 */
export function RelationPicker({
    value,
    onChange,
    options,
    placeholder,
    allowClear = true,
    ...common
}: Common & {
    value: number | null;
    onChange: (value: number | null) => void;
    options: readonly Option[];
    placeholder?: string;
    allowClear?: boolean;
}): JSX.Element {
    const t = useT();
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const selected = options.find((option) => Number(option.value) === value) ?? null;
    const filtered = useMemo(() => {
        const needle = normalizeSearch(query);
        if (needle === '') return options.slice(0, 50);
        return options.filter((option) => normalizeSearch(option.label).includes(needle)).slice(0, 50);
    }, [options, query]);

    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <div className="relative" ref={containerRef}>
                    <div className="flex items-center gap-2">
                        <input
                            id={id}
                            type="text"
                            role="combobox"
                            aria-expanded={open}
                            aria-autocomplete="list"
                            aria-describedby={describedBy}
                            aria-invalid={invalid || undefined}
                            disabled={common.disabled}
                            value={open ? query : (selected?.label ?? '')}
                            placeholder={placeholder ?? t('form.searchOption')}
                            onFocus={() => {
                                setOpen(true);
                                setQuery('');
                            }}
                            onBlur={() => setTimeout(() => setOpen(false), 120)}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setOpen(true);
                            }}
                            className={cn(CONTROL, invalid && 'ring-danger', FOCUS_RING)}
                        />
                        {allowClear && value !== null && !common.disabled ? (
                            <button
                                type="button"
                                onClick={() => onChange(null)}
                                aria-label={t('action.reset')}
                                className={cn('min-h-touch min-w-touch rounded-pos text-slate-400 hover:text-slate-700', FOCUS_RING)}
                            >
                                ✕
                            </button>
                        ) : null}
                    </div>

                    {open ? (
                        <ul
                            role="listbox"
                            className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-pos bg-white p-1 shadow-pos-lg ring-1 ring-slate-200"
                        >
                            {filtered.length === 0 ? (
                                <li className="px-3 py-2 text-sm text-slate-500">{t('form.noOption')}</li>
                            ) : (
                                filtered.map((option) => (
                                    <li key={option.value}>
                                        <button
                                            type="button"
                                            role="option"
                                            aria-selected={Number(option.value) === value}
                                            onMouseDown={(event) => event.preventDefault()}
                                            onClick={() => {
                                                onChange(Number(option.value));
                                                setOpen(false);
                                            }}
                                            className={cn(
                                                'flex min-h-touch w-full items-center rounded-pos px-3 text-start text-sm hover:bg-slate-50',
                                                Number(option.value) === value && 'bg-brand-50 font-semibold',
                                                FOCUS_RING,
                                            )}
                                        >
                                            {option.label}
                                        </button>
                                    </li>
                                ))
                            )}
                        </ul>
                    ) : null}
                </div>
            )}
        </Field>
    );
}

// ───────────────────────────────────────────────────────────── toggle

export function ToggleField({
    checked,
    onChange,
    description,
    ...common
}: Common & {
    checked: boolean;
    onChange: (checked: boolean) => void;
    description?: ReactNode;
}): JSX.Element {
    const base = useId();
    const id = `${base}-toggle`;
    const hintId = common.hint ? `${base}-hint` : undefined;

    return (
        <div className={cn('flex items-start gap-3', common.className)}>
            <button
                type="button"
                id={id}
                role="switch"
                aria-checked={checked}
                aria-describedby={hintId}
                disabled={common.disabled}
                onClick={() => onChange(!checked)}
                className={cn(
                    'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
                    checked ? 'bg-brand-600' : 'bg-slate-300',
                    common.disabled && 'cursor-not-allowed opacity-50',
                    FOCUS_RING,
                )}
            >
                <span
                    aria-hidden
                    className={cn(
                        'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
                        checked ? 'start-[1.375rem]' : 'start-0.5',
                    )}
                />
            </button>

            <div className="min-w-0">
                <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-700">
                    {common.label}
                    {common.lockedReason ? (
                        <span className="text-xs font-normal text-slate-500" title={common.lockedReason}>
                            🔒<span className="sr-only">{common.lockedReason}</span>
                        </span>
                    ) : null}
                </label>
                {description ? <p className="text-sm text-slate-600">{description}</p> : null}
                {common.hint ? (
                    <p id={hintId} className="text-xs text-slate-500">
                        {common.hint}
                    </p>
                ) : null}
                {common.error ? (
                    <p className="text-xs font-medium text-danger" role="alert">
                        {common.error}
                    </p>
                ) : null}
            </div>
        </div>
    );
}

// ───────────────────────────────────────────────────────────── date / time

export function DateField({
    value,
    onChange,
    min,
    max,
    ...common
}: Common & {
    value: string;
    onChange: (value: string) => void;
    min?: string;
    max?: string;
}): JSX.Element {
    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <input
                    id={id}
                    type="date"
                    value={value}
                    min={min}
                    max={max}
                    disabled={common.disabled}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => onChange(event.target.value)}
                    className={cn(CONTROL, invalid && 'ring-danger', FOCUS_RING)}
                />
            )}
        </Field>
    );
}

export function TimeField({
    value,
    onChange,
    ...common
}: Common & {
    value: string;
    onChange: (value: string) => void;
}): JSX.Element {
    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <input
                    id={id}
                    type="time"
                    value={value}
                    disabled={common.disabled}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => onChange(event.target.value)}
                    className={cn(CONTROL, invalid && 'ring-danger', FOCUS_RING)}
                />
            )}
        </Field>
    );
}

/** Odoo-style palette index (`color` columns are `tinyint`). */
export function ColorIndexField({
    value,
    onChange,
    ...common
}: Common & {
    value: number;
    onChange: (value: number) => void;
}): JSX.Element {
    const swatches = [
        '#94a3b8', '#ef4444', '#f97316', '#f59e0b', '#84cc16',
        '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
        '#78716c', '#0f172a',
    ];

    return (
        <Field {...common}>
            {({ id, describedBy }) => (
                <div id={id} aria-describedby={describedBy} role="radiogroup" className="flex flex-wrap gap-1.5">
                    {swatches.map((colour, index) => (
                        <button
                            key={colour}
                            type="button"
                            role="radio"
                            aria-checked={value === index}
                            aria-label={`Couleur ${index}`}
                            disabled={common.disabled}
                            onClick={() => onChange(index)}
                            style={{ backgroundColor: colour }}
                            className={cn(
                                'h-8 w-8 rounded-pos ring-2 ring-offset-2',
                                value === index ? 'ring-slate-900' : 'ring-transparent',
                                FOCUS_RING,
                            )}
                        />
                    ))}
                </div>
            )}
        </Field>
    );
}

/** A free CSS colour, for floor backgrounds and self-order branding. */
export function ColorField({
    value,
    onChange,
    ...common
}: Common & {
    value: string | null;
    onChange: (value: string | null) => void;
}): JSX.Element {
    const t = useT();
    return (
        <Field {...common}>
            {({ id, describedBy, invalid }) => (
                <div className="flex items-center gap-2">
                    <input
                        id={id}
                        type="color"
                        value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'}
                        disabled={common.disabled}
                        aria-describedby={describedBy}
                        aria-invalid={invalid || undefined}
                        onChange={(event) => onChange(event.target.value)}
                        className={cn('h-11 w-16 cursor-pointer rounded-pos ring-1 ring-inset ring-slate-300', FOCUS_RING)}
                    />
                    <input
                        type="text"
                        value={value ?? ''}
                        placeholder="#ffffff"
                        disabled={common.disabled}
                        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
                        className={cn(CONTROL, 'font-mono text-sm', FOCUS_RING)}
                    />
                    {value !== null && !common.disabled ? (
                        <button
                            type="button"
                            onClick={() => onChange(null)}
                            className={cn('min-h-touch rounded-pos px-2 text-sm text-slate-500 hover:text-slate-800', FOCUS_RING)}
                        >
                            {t('state.none')}
                        </button>
                    ) : null}
                </div>
            )}
        </Field>
    );
}

// ───────────────────────────────────────────────────────────── image

/**
 * Image picker with a local preview.
 *
 * `onChange` hands back the `File` (for a multipart submit) and a data URL for the preview.
 * Nothing is uploaded here; the owning form decides.
 */
export function ImageField({
    previewUrl,
    onChange,
    maxMb = 4,
    ...common
}: Common & {
    previewUrl: string | null;
    onChange: (file: File | null, preview: string | null) => void;
    maxMb?: number;
}): JSX.Element {
    const t = useT();
    const inputRef = useRef<HTMLInputElement>(null);
    const [localError, setLocalError] = useState<string | null>(null);

    const accept = useCallback(
        (file: File | null) => {
            if (file === null) {
                setLocalError(null);
                onChange(null, null);
                return;
            }
            if (file.size > maxMb * 1024 * 1024) {
                setLocalError(t('form.imageTooLarge', { max: maxMb }));
                return;
            }
            setLocalError(null);
            const reader = new FileReader();
            reader.onload = () => onChange(file, typeof reader.result === 'string' ? reader.result : null);
            reader.readAsDataURL(file);
        },
        [maxMb, onChange, t],
    );

    return (
        <Field {...common} error={common.error ?? localError ?? undefined}>
            {({ id, describedBy, invalid }) => (
                <div className="flex items-start gap-3">
                    <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-pos bg-slate-100 ring-1 ring-inset ring-slate-200">
                        {previewUrl ? (
                            <img src={previewUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                            <span aria-hidden className="text-2xl text-slate-400">
                                🖼
                            </span>
                        )}
                    </div>

                    <div className="min-w-0 flex-1">
                        <input
                            ref={inputRef}
                            id={id}
                            type="file"
                            accept="image/*"
                            disabled={common.disabled}
                            aria-describedby={describedBy}
                            aria-invalid={invalid || undefined}
                            onChange={(event) => accept(event.target.files?.[0] ?? null)}
                            className={cn(
                                'block w-full text-sm text-slate-600',
                                'file:me-3 file:min-h-touch file:rounded-pos file:border-0 file:bg-slate-100 file:px-4 file:font-semibold file:text-slate-700',
                                'disabled:cursor-not-allowed disabled:opacity-60',
                                FOCUS_RING,
                            )}
                        />
                        <p className="mt-1 text-xs text-slate-500">{t('form.imageDrop')}</p>
                        {previewUrl && !common.disabled ? (
                            <button
                                type="button"
                                onClick={() => {
                                    if (inputRef.current) inputRef.current.value = '';
                                    accept(null);
                                }}
                                className={cn('mt-1 min-h-touch rounded-pos text-sm text-danger hover:underline', FOCUS_RING)}
                            >
                                {t('form.imageRemove')}
                            </button>
                        ) : null}
                    </div>
                </div>
            )}
        </Field>
    );
}

// ───────────────────────────────────────────────────────────── layout

export function FormSection({
    title,
    description,
    children,
    columns = 2,
    className,
}: {
    title?: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    columns?: 1 | 2 | 3;
    className?: string;
}): JSX.Element {
    return (
        <section className={cn('py-2', className)}>
            {title ? (
                <div className="mb-4">
                    <h3 className="text-base font-semibold text-slate-900">{title}</h3>
                    {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
                </div>
            ) : null}
            <div
                className={cn(
                    'grid gap-x-6 gap-y-4',
                    columns === 1 && 'grid-cols-1',
                    columns === 2 && 'grid-cols-1 md:grid-cols-2',
                    columns === 3 && 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
                )}
            >
                {children}
            </div>
        </section>
    );
}

/** Full-width child inside a `FormSection` grid. */
export function FormRow({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
    return <div className={cn('md:col-span-2 xl:col-span-3', className)}>{children}</div>;
}
