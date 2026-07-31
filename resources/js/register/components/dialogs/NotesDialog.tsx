import { Button, Dialog, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { useT } from '../../i18n';
import {
    setCustomerNote,
    setInternalNote,
    setLineCourse,
    setOrderInternalNote,
    setOrderNote,
} from '../../domain/order-actions';
import { useCatalog, useOrder, useSelectedOrderUuid } from '../../hooks/use-register';
import { useOrderStore } from '../../state/order-store';
import { useUiStore } from '../../state/ui-store';

/**
 * Notes (REG-109, REG-110, REG-111).
 *
 * The internal (kitchen) note is stored as a **JSON array of `{text, colorIndex}`**, not a string —
 * that is what lets the predefined-note chips keep their colour on the kitchen ticket, and it is
 * also why a note change is a distinct kitchen ticket type rather than a silent edit (KDS-021).
 */

const NOTE_COLORS = [
    'bg-slate-200 text-slate-900',
    'bg-amber-200 text-amber-950',
    'bg-sky-200 text-sky-950',
    'bg-emerald-200 text-emerald-950',
    'bg-rose-200 text-rose-950',
    'bg-violet-200 text-violet-950',
];

export function NotesDialog(): JSX.Element | null {
    const t = useT();
    const catalog = useCatalog();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);
    const orderUuid = useSelectedOrderUuid();
    const order = useOrder(orderUuid);
    const lineUuid = typeof dialog?.payload?.['lineUuid'] === 'string' ? dialog.payload['lineUuid'] : null;
    const line = useOrderStore((state) => (lineUuid === null ? null : (state.lines[lineUuid] ?? null)));
    const coursesRecord = useOrderStore((state) => state.courses);
    const orderCourses = useMemo(
        () => Object.values(coursesRecord).filter((course) => course.order_uuid === orderUuid).sort((a, b) => a.index - b.index),
        [coursesRecord, orderUuid],
    );

    const [customerNote, setCustomerNoteDraft] = useState<string>(
        line?.customer_note ?? order?.general_customer_note ?? '',
    );
    const [internal, setInternal] = useState<Array<{ text: string; color_index: number }>>(
        line?.internal_note ?? [],
    );
    const [freeNote, setFreeNote] = useState('');

    if (dialog?.kind !== 'notes' || orderUuid === null) return null;

    const scope = line ? 'line' : 'order';
    const chips = catalog.notes.filter(
        (note) => note.scope === 'both' || note.scope === (scope === 'line' ? 'line' : 'order'),
    );

    const toggleChip = (name: string, color: number): void => {
        setInternal((current) =>
            current.some((note) => note.text === name)
                ? current.filter((note) => note.text !== name)
                : [...current, { text: name, color_index: color }],
        );
    };

    const save = (): void => {
        if (line) {
            setCustomerNote(line.uuid, customerNote);
            const notes = freeNote.trim() === '' ? internal : [...internal, { text: freeNote.trim(), color_index: 0 }];
            setInternalNote(line.uuid, notes);
        } else {
            setOrderNote(orderUuid, customerNote);
            const text = [...internal.map((note) => note.text), freeNote.trim()].filter(Boolean).join(' · ');
            setOrderInternalNote(orderUuid, text === '' ? null : text);
        }
        close();
    };

    return (
        <Dialog
            open
            onClose={close}
            title={line ? line.full_product_name : t('reg.order.orderNote')}
            description={t('reg.order.notesTitle')}
            size="lg"
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    <Button onClick={save}>{t('common.ok')}</Button>
                </>
            }
        >
            <div className="space-y-4">
                {line && orderCourses.length > 0 ? (
                    <label className="grid gap-1">
                        <span className="font-semibold">{t('reg.order.moveCourse')}</span>
                        <select
                            className="min-h-touch-lg rounded-pos border border-slate-300 px-3"
                            value={line.course_uuid ?? ''}
                            onChange={(event) => setLineCourse(line.uuid, event.target.value === '' ? null : event.target.value)}
                        >
                            <option value="">{t('reg.order.noCourse')}</option>
                            {orderCourses.map((course) => (
                                <option key={course.uuid} value={course.uuid}>
                                    {course.name ?? t('reg.order.course', { index: course.index })}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}

                <label className="grid gap-1">
                    <span className="font-semibold">{t('reg.order.customerNote')}</span>
                    <textarea
                        rows={2}
                        className="rounded-pos border border-slate-300 p-2"
                        value={customerNote}
                        onChange={(event) => setCustomerNoteDraft(event.target.value)}
                    />
                </label>

                <div>
                    <p className="mb-2 font-semibold">{t('reg.order.predefinedNotes')}</p>
                    <div className="flex flex-wrap gap-2">
                        {chips.map((note) => {
                            const active = internal.some((entry) => entry.text === note.name);
                            return (
                                <button
                                    key={note.id}
                                    type="button"
                                    onClick={() => toggleChip(note.name, note.color)}
                                    className={cn(
                                        'min-h-touch rounded-pos px-3 font-semibold ring-1 ring-inset',
                                        NOTE_COLORS[note.color % NOTE_COLORS.length],
                                        active ? 'ring-slate-900' : 'ring-transparent opacity-70',
                                    )}
                                >
                                    {note.name}
                                </button>
                            );
                        })}
                        {chips.length === 0 ? <p className="text-slate-500">—</p> : null}
                    </div>
                </div>

                <label className="grid gap-1">
                    <span className="font-semibold">{t('reg.order.freeNote')}</span>
                    <input
                        type="text"
                        className="min-h-touch-lg rounded-pos border border-slate-300 px-3"
                        value={freeNote}
                        onChange={(event) => setFreeNote(event.target.value)}
                    />
                </label>
            </div>
        </Dialog>
    );
}
