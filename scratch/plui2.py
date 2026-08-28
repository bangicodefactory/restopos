import io

p = 'resources/js/backoffice/pages/Pricelists/Edit.tsx'
s = io.open(p, encoding='utf-8', newline='').read()


def sub(old, new):
    global s
    assert old in s, 'MISSING: ' + old[:80]
    s = s.replace(old, new, 1)


# The docblock still described the screen as read-only.
sub(""" * The header (name, sequence, currency, active) is editable; the rules are not, because
 * `PATCH /pricelists/{pricelist}` validates only those four keys and the contract exposes no
 * write for `pricelist_items`. Rather than pretend, the rule editor is a **read-only explorer**
 * built around the thing operators actually need: understanding *which* rule wins.
 *
 * So the rules are ordered by real resolution order""",
""" * The header (name, sequence, currency, active) is editable, and since BAN-401 so are the rules:
 * `POST/PATCH/DELETE /pricelists/{pricelist}/items` exist, so happy hour or a category markdown can
 * be set up here instead of in a shell. Before that this screen was a read-only explorer, because
 * the contract exposed no write for `pricelist_items` at all.
 *
 * What the explorer got right is kept: the thing operators actually need from this table is
 * understanding *which* rule wins. So the rules are ordered by real resolution order""")

# Imports.
sub("import { Head, useForm } from '@inertiajs/react';",
    "import { Head, router, useForm } from '@inertiajs/react';\nimport { Button } from '@shared/ui';")
sub("import { FormSection } from '../../components/form/fields';",
    "import { FormSection, MoneyField, SelectField } from '../../components/form/fields';")

# Props.
sub("export default function PricelistEdit({ pricelist, items }: PricelistEditProps): JSX.Element {",
    "export default function PricelistEdit({\n    pricelist,\n    items,\n    products,\n    categories,\n}: PricelistEditProps): JSX.Element {")

# A delete action on each rule.
sub("""        {
            id: 'window',""",
"""        {
            id: 'remove',
            header: '',
            exportValue: () => '',
            cell: (row) => (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                        router.delete(routes.pricelistItems.destroy(pricelist.id, row.id), {
                            preserveScroll: true,
                        })
                    }
                >
                    {t('action.delete')}
                </Button>
            ),
        },
        {
            id: 'window',""")

# The percent input: TextField has no `suffix`, and the label already carries the unit.
sub("""                            error={form.errors.percent_price}
                            suffix="%"
                            onChange""",
"""                            error={form.errors.percent_price}
                            onChange""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('edit.tsx patched')
