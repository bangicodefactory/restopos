/**
 * `ProductCategories/Index` props — the accounting category tree (BAN-501).
 *
 * Distinct from the POS categories a cashier browses. This tree answers "which revenue account does
 * this sale post to": `ledger_code` is echoed into the `label` column of every sales row in the
 * accounting export.
 */

export type ProductCategoryRow = {
    id: number;
    name: string;
    parent_id: number | null;
    sequence: number;
    ledger_code: string | null;
    /** Derived from `path` server-side — this table does not denormalise it. */
    depth: number;
    product_count: number;
};

export type ProductCategoriesIndexProps = {
    categories: ProductCategoryRow[];
};

/**
 * Every category that may be a parent of `subject`.
 *
 * Excludes the node itself and its own descendants, because the server refuses both and offering
 * them means the only way to learn the rule is to be told off by a save that failed. Walks
 * `parent_id` rather than reading `path`, which is not in the payload and does not need to be.
 */
export function parentChoices(
    categories: ProductCategoryRow[],
    subject: ProductCategoryRow | null,
): ProductCategoryRow[] {
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
