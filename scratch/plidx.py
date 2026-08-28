import io

# ── the page ────────────────────────────────────────────────────────────────
p = 'resources/js/backoffice/pages/Pricelists/Index.tsx'
s = io.open(p, encoding='utf-8', newline='').read()


def sub(old, new):
    global s
    assert old in s, 'MISSING: ' + old[:80]
    s = s.replace(old, new, 1)


sub("import { Head, Link } from '@inertiajs/react';\nimport { FOCUS_RING, cn } from '@shared/ui';",
    "import { Head, Link, router, useForm } from '@inertiajs/react';\nimport { Button, FOCUS_RING, cn } from '@shared/ui';")
sub("import { AppLayout } from '../../components/layout/AppLayout';",
    "import { FormSection, SelectField, TextField } from '../../components/form/fields';\nimport { AppLayout } from '../../components/layout/AppLayout';")
sub("import { Badge } from '../../components/ui/primitives';",
    "import { Badge, Card, CardBody, CardHeader } from '../../components/ui/primitives';")
sub("import type { PricelistListRow, PricelistsIndexProps } from './types';",
    "import type { PricelistListRow, PricelistsIndexProps } from './types';")

sub("export default function PricelistsIndex({ pricelists }: PricelistsIndexProps): JSX.Element {",
    "export default function PricelistsIndex({ pricelists, currencies }: PricelistsIndexProps): JSX.Element {")

# The edit link gains a sibling that removes the list.
sub("""                    {t('action.edit')}
                </Link>
            ),
        },
    ];""",
"""                    {t('action.edit')}
                </Link>
            ),
        },
        {
            id: 'remove',
            header: '',
            align: 'end',
            exportValue: () => '',
            cell: (row) => (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => router.delete(routes.pricelists.destroy(row.id), { preserveScroll: true })}
                >
                    {t('action.delete')}
                </Button>
            ),
        },
    ];""")

sub("""            <Head title={t('pricelist.title')} />

            <DataTable""",
"""            <Head title={t('pricelist.title')} />

            {/* A price list could be edited but never created — BAN-401. */}
            <AddPricelist currencies={currencies} />

            <DataTable""")

s = s.rstrip() + """

/** Creating a price list: a name and the currency it prices in. Its rules are added on its own page. */
function AddPricelist({ currencies }: { currencies: PricelistsIndexProps['currencies'] }): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{ name: string; currency_id: string }>({
        name: '',
        currency_id: currencies[0] === undefined ? '' : String(currencies[0].id),
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('pricelist.add')}
            </Button>
        );
    }

    return (
        <Card>
            <CardHeader title={t('pricelist.add')} description={t('pricelist.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('field.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        required
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('pricelist.currency')}
                        value={form.data.currency_id}
                        error={form.errors.currency_id}
                        options={currencies.map((c) => ({ value: String(c.id), label: `${c.name} (${c.code})` }))}
                        onChange={(value) => form.setData('currency_id', value)}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() => form.post(routes.pricelists.store(), { onSuccess: () => setOpen(false) })}
                    >
                        {t('action.save')}
                    </Button>
                    <Button variant="ghost" onClick={() => setOpen(false)}>
                        {t('action.cancel')}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
"""

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the props type ──────────────────────────────────────────────────────────
p = 'resources/js/backoffice/pages/Pricelists/types.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """export type PricelistsIndexProps = {
    pricelists: PricelistListRow[];
};"""
assert old in s
s = s.replace(old, """export type PricelistsIndexProps = {
    pricelists: PricelistListRow[];
    /** What a new list can price in. Currencies are global reference data, not company-owned. */
    currencies: { id: number; name: string; code: string }[];
};""", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('index patched')
