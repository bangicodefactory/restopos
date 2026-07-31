import type { JSX } from 'react';
import { useMemo } from 'react';

import { categoryAvailableNow, type CatalogIndex } from '../data/catalog';
import { useT } from '../i18n';
import { cn } from '@shared/ui';

import { useUiStore } from '../state/ui-store';

/**
 * The category rail (REG-060 … REG-063).
 *
 * Odoo's "clicking the already-selected category goes *up* one level" is unintuitive on paper and
 * pure muscle memory for anyone who has used the product, so it stays — with a breadcrumb added, so
 * a new cashier can see where they are instead of guessing.
 *
 * Time-windowed categories (breakfast menus) are hidden outside their hours (REG-063).
 */

export function CategoryRail({ catalog }: { catalog: CatalogIndex }): JSX.Element {
    const t = useT();
    const categoryId = useUiStore((state) => state.categoryId);
    const setCategory = useUiStore((state) => state.setCategory);

    const { children, breadcrumb } = useMemo(() => {
        const now = new Date();
        const list = (catalog.categoryChildren.get(categoryId ?? 0) ?? []).filter((category) =>
            categoryAvailableNow(category, now),
        );

        const trail: Array<{ id: number | null; name: string }> = [{ id: null, name: t('reg.products.all') }];
        if (categoryId !== null) {
            const current = catalog.categoriesById.get(categoryId);
            for (const ancestorId of current?.ancestorIds ?? []) {
                const ancestor = catalog.categoriesById.get(ancestorId);
                if (ancestor) trail.push({ id: ancestor.id, name: ancestor.name });
            }
            if (current) trail.push({ id: current.id, name: current.name });
        }

        return { children: list, breadcrumb: trail };
    }, [catalog, categoryId, t]);

    const parentId =
        categoryId === null
            ? null
            : (catalog.categoriesById.get(categoryId)?.parent_id ?? null);

    return (
        <div className="flex flex-col gap-2">
            <nav aria-label="Fil d'Ariane" className="flex flex-wrap items-center gap-1 text-sm text-slate-600">
                {breadcrumb.map((crumb, index) => (
                    <span key={`${crumb.id ?? 'root'}-${index}`} className="flex items-center gap-1">
                        {index > 0 ? <span aria-hidden>›</span> : null}
                        <button
                            type="button"
                            className="min-h-touch rounded-pos px-2 hover:bg-slate-100"
                            onClick={() => setCategory(crumb.id)}
                        >
                            {crumb.name}
                        </button>
                    </span>
                ))}
            </nav>

            <div className="flex gap-2 overflow-x-auto pb-1">
                {categoryId !== null ? (
                    <button
                        type="button"
                        onClick={() => setCategory(parentId)}
                        className="min-h-touch-lg shrink-0 rounded-pos bg-slate-200 px-4 font-semibold text-slate-800"
                    >
                        ↑ {t('reg.products.up')}
                    </button>
                ) : null}

                {children.map((category) => (
                    <button
                        key={category.id}
                        type="button"
                        onClick={() => setCategory(category.id)}
                        className={cn(
                            'min-h-touch-lg shrink-0 rounded-pos px-4 font-semibold ring-1 ring-inset',
                            category.id === categoryId
                                ? 'bg-brand-600 text-white ring-brand-700'
                                : 'bg-white text-slate-800 ring-slate-300 hover:bg-slate-50',
                        )}
                    >
                        {category.name}
                    </button>
                ))}
            </div>
        </div>
    );
}
