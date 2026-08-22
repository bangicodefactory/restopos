/**
 * `PrepDisplays/Index` and `PrepDisplays/Edit` props — spec 05 §12.
 *
 * The list is a hand-picked projection (no `access_token`, no `auto_advance_on_all_ready`); the
 * edit page is `attributesToArray()`, so it carries every `prep_displays` column. Two different
 * shapes for the same entity, typed as two different types rather than one optional-everything
 * union that would make `display.access_token` look nullable where it never is.
 */

export type PrepDisplayListRow = {
    id: number;
    uuid: string;
    name: string;
    layout: string;
    average_prep_minutes: number;
    late_threshold_minutes: number;
    done_retention_minutes: number;
    show_all_categories: boolean;
    sound_on_new_order: boolean;
    active: boolean;
};

export type PrepDisplaysIndexProps = {
    displays: PrepDisplayListRow[];
};

export type PrepDisplayRecord = {
    id: number;
    uuid: string;
    company_id: number;
    name: string;
    access_token: string;
    layout: string;
    auto_advance_on_all_ready: boolean;
    show_all_categories: boolean;
    average_prep_minutes: number;
    late_threshold_minutes: number;
    done_retention_minutes: number;
    sound_on_new_order: boolean;
    active: boolean;
    created_at: string | null;
    updated_at: string | null;
};

/** A `prep_stages` row, straight off the query builder. */
export type PrepStageRow = {
    id: number;
    prep_display_id: number;
    name: string;
    stage_type: string;
    color: string | null;
    alert_after_minutes: number | null;
    sequence: number;
    is_default: boolean | number;
    created_at: string | null;
    updated_at: string | null;
};

export type PrepCategory = {
    id: number;
    name: string;
    parent_id: number | null;
};

export type PrepDisplayEditProps = {
    display: PrepDisplayRecord;
    stages: PrepStageRow[];
    categoryIds: number[];
    categories: PrepCategory[];
};

/**
 * The keys `PATCH /prep-displays/{prepDisplay}` validates.
 *
 * `stages` is part of the contract: the ordered list *is* the board's state machine, so the editor
 * submits it whole and the server reconciles it by id (BAN-435).
 */
export const WRITABLE_DISPLAY_KEYS = [
    'name',
    'layout',
    'average_prep_minutes',
    'late_threshold_minutes',
    'done_retention_minutes',
    'show_all_categories',
    'auto_advance_on_all_ready',
    'sound_on_new_order',
    'active',
    'category_ids',
    'stages',
] as const;

export const LAYOUT_LABEL: Record<string, string> = {
    columns: 'Colonnes',
    grid: 'Grille',
    list: 'Liste',
};

export const STAGE_TYPE_LABEL: Record<string, string> = {
    todo: 'À faire',
    in_progress: 'En cours',
    ready: 'Prêt',
    done: 'Servi',
};

/** Default swatch per stage type, used when a stage has no colour of its own. */
export const STAGE_TYPE_COLOR: Record<string, string> = {
    todo: '#94a3b8',
    in_progress: '#f59e0b',
    ready: '#10b981',
    done: '#3b82f6',
};

export type PrepDisplayForm = {
    name: string;
    layout: string;
    average_prep_minutes: number | null;
    late_threshold_minutes: number | null;
    done_retention_minutes: number | null;
    show_all_categories: boolean;
    auto_advance_on_all_ready: boolean;
    sound_on_new_order: boolean;
    active: boolean;
    category_ids: number[];
};

export function toForm(display: PrepDisplayRecord, categoryIds: number[]): PrepDisplayForm {
    return {
        name: display.name,
        layout: display.layout,
        average_prep_minutes: display.average_prep_minutes,
        late_threshold_minutes: display.late_threshold_minutes,
        done_retention_minutes: display.done_retention_minutes,
        show_all_categories: display.show_all_categories,
        auto_advance_on_all_ready: display.auto_advance_on_all_ready,
        sound_on_new_order: display.sound_on_new_order,
        active: display.active,
        category_ids: categoryIds,
    };
}

/** Indented `{value,label}` options for a nested POS-category list. */
export function categoryOptions(categories: readonly PrepCategory[]): { value: string; label: string }[] {
    const byParent = new Map<number | null, PrepCategory[]>();
    for (const category of categories) {
        const bucket = byParent.get(category.parent_id);
        if (bucket) bucket.push(category);
        else byParent.set(category.parent_id, [category]);
    }

    const out: { value: string; label: string }[] = [];
    const walk = (parent: number | null, depth: number): void => {
        for (const category of byParent.get(parent) ?? []) {
            out.push({ value: String(category.id), label: `${'— '.repeat(depth)}${category.name}` });
            if (depth < 6) walk(category.id, depth + 1);
        }
    };
    walk(null, 0);

    if (out.length < categories.length) {
        const seen = new Set(out.map((option) => option.value));
        for (const category of categories) {
            if (!seen.has(String(category.id))) out.push({ value: String(category.id), label: category.name });
        }
    }

    return out;
}
