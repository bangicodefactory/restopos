/**
 * `Categories/Index` props — spec 05 §12 (BOF-084, BOF-085).
 *
 * `hour_after` / `hour_until` are `decimal(5,2)` **decimal hours** (14.5 = 14:30), not clock
 * strings; they arrive as strings and are converted for display by `lib/format`.
 */

export type CategoryRow = {
    id: number;
    name: string;
    parent_id: number | null;
    depth: number;
    sequence: number;
    color: number;
    hour_after: string | null;
    hour_until: string | null;
    self_order_visible: boolean;
    active: boolean;
};

export type CategoriesIndexProps = {
    categories: CategoryRow[];
};

/** A category with its children resolved, for rendering the tree. */
export type CategoryNode = CategoryRow & {
    children: CategoryNode[];
};

/** Build the forest from the flat list, ordered by `sequence` then name. */
export function buildTree(rows: readonly CategoryRow[]): CategoryNode[] {
    const nodes = new Map<number, CategoryNode>();
    for (const row of rows) nodes.set(row.id, { ...row, children: [] });

    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
        const parent = node.parent_id === null ? null : (nodes.get(node.parent_id) ?? null);
        if (parent) parent.children.push(node);
        else roots.push(node);
    }

    const sort = (list: CategoryNode[]): void => {
        list.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name, 'fr'));
        for (const node of list) sort(node.children);
    };
    sort(roots);

    return roots;
}

/** Depth-first flatten, so the tree can be rendered as one list of rows. */
export function flattenTree(nodes: readonly CategoryNode[], depth = 0): { node: CategoryNode; depth: number }[] {
    const out: { node: CategoryNode; depth: number }[] = [];
    for (const node of nodes) {
        out.push({ node, depth });
        out.push(...flattenTree(node.children, depth + 1));
    }
    return out;
}

/**
 * Every category that may be a parent of `subject`.
 *
 * Excludes the node itself and its own descendants — the server refuses both, and offering them in
 * the picker means the only way to learn that is to be told off. Walks `parent_id` rather than
 * reading `path`, because `path` is not in the page payload and does not need to be.
 */
export function parentOptions(categories: CategoryRow[], subject: CategoryRow | null): CategoryRow[] {
    if (subject === null) return categories;

    const banned = new Set<number>([subject.id]);
    let grew = true;

    while (grew) {
        grew = false;
        for (const candidate of categories) {
            if (candidate.parent_id !== null && banned.has(candidate.parent_id) && !banned.has(candidate.id)) {
                banned.add(candidate.id);
                grew = true;
            }
        }
    }

    return categories.filter((candidate) => !banned.has(candidate.id));
}
