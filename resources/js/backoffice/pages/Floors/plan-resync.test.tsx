/** @vitest-environment jsdom */
/**
 * The floor plan must adopt the server's table ids after a save (BAN-444).
 *
 * A table drawn on the canvas gets a negative id, and `syncTables` reads any negative id as "create
 * this". The page seeded its plan with `useState(initialPlan)`, which reads its argument once — so
 * once the save had created the table and given it a real id, the plan still held the negative one.
 *
 * The next save re-sent that negative id. `syncTables` created a *second* table, and its deletion
 * pass — which keeps only ids present in the payload — deleted the first. Probed against the real
 * controller: id 3 carrying QR token `t68og6ru` became id 4 carrying `vpmk0i1n`.
 *
 * `identifier` is the table's QR capability token, so every save after adding a table silently
 * reissued that table's QR and invalidated the code already printed and stuck to it — with nothing
 * on screen saying so.
 *
 * The real page is rendered rather than a copy of its four lines: a reproduction would keep passing
 * if someone deleted the effect from `Edit.tsx`, which is the only thing this is guarding.
 */

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FloorEditProps } from './types';

const patch = vi.fn();
const transform = vi.fn();

vi.mock('@inertiajs/react', () => ({
    Head: () => null,
    Link: ({ children }: { children?: unknown }) => children,
    router: { reload: vi.fn(), visit: vi.fn(), on: () => () => {}, delete: vi.fn() },
    // `AppLayout` reads shared props for the nav, the flash strip and the acting user.
    usePage: () => ({
        props: {
            auth: { user: { id: 1, name: 'Test', email: 't@example.test' }, can: {} },
            flash: {},
            errors: {},
            locale: 'fr',
        },
        url: '/floors/floor-uuid/edit',
        component: 'Floors/Edit',
        version: '1',
    }),
    useForm: () => ({
        data: { name: 'Salle', background_color: null, sequence: 1, active: true },
        setData: vi.fn(),
        errors: {},
        processing: false,
        isDirty: true,
        transform,
        patch,
        reset: vi.fn(),
    }),
}));

const { default: FloorEdit } = await import('./Edit');

type Row = { id: number; table_number: number };

function propsFor(tables: Row[]): FloorEditProps {
    return {
        floor: {
            id: 1,
            uuid: 'floor-uuid',
            company_id: 1,
            name: 'Salle',
            background_color: null,
            background_media_id: null,
            sequence: 1,
            active: true,
            table_count: tables.length,
            created_at: null,
            updated_at: null,
            deleted_at: null,
        },
        tables: tables.map((t) => ({
            id: t.id,
            uuid: `table-${t.id}`,
            restaurant_floor_id: 1,
            company_id: 1,
            parent_id: null,
            table_number: t.table_number,
            name: null,
            shape: 'square' as const,
            // Decimal columns arrive as strings; `toPlanTable` is what turns them into numbers.
            position_x: '10',
            position_y: '10',
            width: '50',
            height: '50',
            seats: 2,
            color: null,
            active: true,
            identifier: `qr-${t.id}`,
            created_at: null,
            updated_at: null,
            deleted_at: null,
        })),
    };
}

/** The ids the page would send on its next save, read off the payload it builds. */
function idsOnNextSave(): number[] {
    const build = transform.mock.calls.at(-1)?.[0] as
        | ((data: Record<string, unknown>) => { tables: { id: number }[] })
        | undefined;

    expect(build, 'the page must transform its payload before patching').toBeTypeOf('function');

    return build!({}).tables.map((t) => t.id);
}

describe('the floor plan after a save', () => {
    beforeEach(() => {
        transform.mockClear();
        patch.mockClear();
    });

    it('carries the id the server assigned, not the local one it invented', () => {
        // Before the save: table 7 exists and the operator has drawn one, which holds a local -1.
        const { rerender, container } = render(
            <FloorEdit {...propsFor([{ id: 7, table_number: 1 }, { id: -1, table_number: 2 }])} />,
        );

        // The save returns and the server reports the new table as id 8.
        rerender(
            <FloorEdit {...propsFor([{ id: 7, table_number: 1 }, { id: 8, table_number: 2 }])} />,
        );

        const save = container.querySelector('[data-test="floor-save"]')
            ?? Array.from(container.querySelectorAll('button')).find((b) => /enregistr|save/i.test(b.textContent ?? ''));

        expect(save, 'could not find the save control — the selector has drifted').toBeTruthy();

        (save as HTMLButtonElement).click();

        // A negative id here is not an update. It is a delete-and-recreate that reissues the QR.
        expect(idsOnNextSave()).toEqual([7, 8]);
    });
});
