/**
 * Tabs, implemented against the WAI-ARIA tabs pattern.
 *
 * Manual activation (arrow keys move focus, Enter/Space selects) rather than automatic: some of
 * these panels are heavy — the register settings editor has ten of them — and arrowing through a
 * tab strip should not mount ten forms.
 */

import { FOCUS_RING, cn } from '@shared/ui';
import { useCallback, useId, useRef, type JSX, type ReactNode } from 'react';

export type TabItem = {
    id: string;
    label: ReactNode;
    badge?: ReactNode;
    disabled?: boolean;
};

export function Tabs({
    items,
    active,
    onChange,
    children,
    label,
}: {
    items: readonly TabItem[];
    active: string;
    onChange: (id: string) => void;
    children: ReactNode;
    label: string;
}): JSX.Element {
    const base = useId();
    const listRef = useRef<HTMLDivElement>(null);

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            const enabled = items.filter((item) => !item.disabled);
            const index = enabled.findIndex((item) => item.id === active);
            if (index === -1) return;

            let next = index;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % enabled.length;
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
                next = (index - 1 + enabled.length) % enabled.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = enabled.length - 1;
            else return;

            event.preventDefault();
            const target = enabled[next];
            if (!target) return;
            onChange(target.id);
            listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${base}-tab-${target.id}`)}`)?.focus();
        },
        [active, base, items, onChange],
    );

    return (
        <div>
            <div
                ref={listRef}
                role="tablist"
                aria-label={label}
                onKeyDown={onKeyDown}
                className="flex flex-wrap gap-1 overflow-x-auto border-b border-slate-200"
            >
                {items.map((item) => {
                    const selected = item.id === active;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            role="tab"
                            id={`${base}-tab-${item.id}`}
                            aria-controls={`${base}-panel-${item.id}`}
                            aria-selected={selected}
                            tabIndex={selected ? 0 : -1}
                            disabled={item.disabled}
                            onClick={() => onChange(item.id)}
                            className={cn(
                                'min-h-touch whitespace-nowrap rounded-t-pos px-4 text-sm font-semibold',
                                FOCUS_RING,
                                selected
                                    ? 'border-b-2 border-brand-600 text-brand-700'
                                    : 'border-b-2 border-transparent text-slate-600 hover:text-slate-900',
                                item.disabled && 'cursor-not-allowed opacity-40',
                            )}
                        >
                            {item.label}
                            {item.badge ? <span className="ms-2">{item.badge}</span> : null}
                        </button>
                    );
                })}
            </div>

            <div
                role="tabpanel"
                id={`${base}-panel-${active}`}
                aria-labelledby={`${base}-tab-${active}`}
                tabIndex={0}
                className={cn('pt-5', FOCUS_RING)}
            >
                {children}
            </div>
        </div>
    );
}
