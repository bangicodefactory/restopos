import io

p = 'resources/js/backoffice/pages/Pricelists/Edit.tsx'
s = io.open(p, encoding='utf-8', newline='').read()


def sub(old, new):
    global s
    assert old in s, 'MISSING: ' + old[:70]
    s = s.replace(old, new, 1)


# ── the notice becomes an editor ────────────────────────────────────────────
sub("""                <div className="space-y-3">
                    <Notice tone="warn">{t('pricelist.itemsReadOnly')}</Notice>
""",
    """                <div className="space-y-3">
                    {/*
                      * The rules were a read-only explorer and there was no endpoint behind them —
                      * "change a price rule" is the most common back-office task in a restaurant and
                      * it could not be done here at all (BAN-401).
                      */}
                    <AddRule pricelist={pricelist} products={products} categories={categories} />
""")

# ── a delete action on each row ─────────────────────────────────────────────
sub("""                        rowClassName={(row) => (windowState(row) !== 'active' || !row.active ? 'opacity-60' : undefined)}""",
    """                        rowClassName={(row) => (windowState(row) !== 'active' || !row.active ? 'opacity-60' : undefined)}""")

# ── the form ────────────────────────────────────────────────────────────────
s = s.rstrip() + """

/**
 * Adding one price rule (BOF-037, BAN-401).
 *
 * The two selects at the top are the ones that matter, and they are separate questions: **what the
 * rule covers** and **how the price is worked out**. The fields below each follow from its choice
 * rather than all being shown at once — a rule form with twenty inputs visible is a form nobody
 * fills in correctly.
 *
 * The empty "computed from" case is the one the server refuses loudest, because a formula rule with
 * no base saves cleanly and prices from the wrong thing.
 */
function AddRule({
    pricelist,
    products,
    categories,
}: {
    pricelist: PricelistEditProps['pricelist'];
    products: PricelistEditProps['products'];
    categories: PricelistEditProps['categories'];
}): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{
        applied_on: string;
        product_id: number | null;
        pos_category_id: number | null;
        compute_price: string;
        fixed_price: string;
        percent_price: string;
    }>({
        applied_on: 'global',
        product_id: null,
        pos_category_id: null,
        compute_price: 'percentage',
        fixed_price: '0',
        percent_price: '10',
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('pricelist.addRule')}
            </Button>
        );
    }

    return (
        <Card>
            <CardHeader title={t('pricelist.addRule')} description={t('pricelist.addRuleHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <SelectField
                        label={t('pricelist.appliesTo')}
                        value={form.data.applied_on}
                        error={form.errors.applied_on}
                        options={[
                            { value: 'global', label: t('pricelist.scopeGlobal') },
                            { value: 'pos_category', label: t('pricelist.scopeCategory') },
                            { value: 'product', label: t('pricelist.scopeProduct') },
                        ]}
                        onChange={(value) => form.setData('applied_on', value)}
                    />

                    {form.data.applied_on === 'product' ? (
                        <SelectField
                            label={t('pricelist.product')}
                            value={form.data.product_id === null ? '' : String(form.data.product_id)}
                            error={form.errors.product_id}
                            options={products.map((p) => ({ value: String(p.id), label: p.name }))}
                            onChange={(value) => form.setData('product_id', value === '' ? null : Number(value))}
                        />
                    ) : null}

                    {form.data.applied_on === 'pos_category' ? (
                        <SelectField
                            label={t('pricelist.category')}
                            value={form.data.pos_category_id === null ? '' : String(form.data.pos_category_id)}
                            error={form.errors.pos_category_id}
                            options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
                            onChange={(value) =>
                                form.setData('pos_category_id', value === '' ? null : Number(value))
                            }
                        />
                    ) : null}

                    <SelectField
                        label={t('pricelist.howPriced')}
                        value={form.data.compute_price}
                        error={form.errors.compute_price}
                        options={[
                            { value: 'percentage', label: t('pricelist.computePercentage') },
                            { value: 'fixed', label: t('pricelist.computeFixed') },
                        ]}
                        onChange={(value) => form.setData('compute_price', value)}
                    />

                    {form.data.compute_price === 'percentage' ? (
                        <TextField
                            label={t('pricelist.percent')}
                            value={form.data.percent_price}
                            error={form.errors.percent_price}
                            suffix="%"
                            onChange={(value) => form.setData('percent_price', value)}
                        />
                    ) : (
                        <MoneyField
                            label={t('pricelist.fixedPrice')}
                            value={form.data.fixed_price}
                            error={form.errors.fixed_price}
                            onChange={(value) => form.setData('fixed_price', value)}
                        />
                    )}
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}
                        onClick={() =>
                            form.post(routes.pricelistItems.store(pricelist.id), {
                                preserveScroll: true,
                                onSuccess: () => {
                                    form.reset();
                                    setOpen(false);
                                },
                            })
                        }
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
print('editor added')
