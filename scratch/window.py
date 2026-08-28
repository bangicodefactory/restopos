import io

p = 'resources/js/backoffice/pages/Pricelists/Edit.tsx'
s = io.open(p, encoding='utf-8', newline='').read()


def sub(old, new):
    global s
    assert old in s, 'MISSING: ' + old[:80]
    s = s.replace(old, new, 1)


sub("import { FormSection, MoneyField, SelectField } from '../../components/form/fields';",
    "import { DateField, FormSection, MoneyField, NumberField as QtyField, SelectField } from '../../components/form/fields';")

sub("""        compute_price: string;
        fixed_price: string;
        percent_price: string;
    }>({""",
"""        compute_price: string;
        fixed_price: string;
        percent_price: string;
        min_quantity: number | null;
        date_start: string;
        date_end: string;
    }>({""")

sub("""        fixed_price: '0',
        percent_price: '10',
    });""",
"""        fixed_price: '0',
        percent_price: '10',
        min_quantity: 1,
        date_start: '',
        date_end: '',
    });""")

# Quantity and the window: happy hour is a rule with an end.
sub("""                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}""",
"""                </FormSection>

                <FormSection title={t('pricelist.whenItApplies')} description={t('pricelist.whenItAppliesHint')}>
                    <QtyField
                        label={t('pricelist.minQty')}
                        value={form.data.min_quantity}
                        error={form.errors.min_quantity}
                        min={0}
                        onChange={(value) => form.setData('min_quantity', value)}
                    />
                    <DateField
                        label={t('pricelist.from')}
                        value={form.data.date_start}
                        error={form.errors.date_start}
                        onChange={(value) => form.setData('date_start', value)}
                    />
                    <DateField
                        label={t('pricelist.until')}
                        value={form.data.date_end}
                        error={form.errors.date_end}
                        onChange={(value) => form.setData('date_end', value)}
                    />
                </FormSection>

                <div className="flex gap-2">
                    <Button
                        loading={form.processing}""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# strings
p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()
for anchor, block in (
    ("    'pricelist.percent': 'Remise (%)',",
     """    'pricelist.whenItApplies': 'Quand elle s\u2019applique',
    'pricelist.whenItAppliesHint': 'Sans dates, la r\u00e8gle s\u2019applique en permanence.',
    'pricelist.from': '\u00c0 partir du',
    'pricelist.until': 'Jusqu\u2019au',
    'pricelist.percent': 'Remise (%)',"""),
    ("    'pricelist.percent': 'Discount (%)',",
     """    'pricelist.whenItApplies': 'When it applies',
    'pricelist.whenItAppliesHint': 'With no dates the rule applies at all times.',
    'pricelist.from': 'From',
    'pricelist.until': 'Until',
    'pricelist.percent': 'Discount (%)',"""),
):
    assert anchor in s, 'MISSING: ' + anchor
    s = s.replace(anchor, block, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('window added')
