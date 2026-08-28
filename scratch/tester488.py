import io

p = 'resources/js/backoffice/pages/BarcodeNomenclatures/Index.tsx'
s = io.open(p, encoding='utf-8', newline='').read()

# ── the tester renders under the rules of every nomenclature ────────────────
old = """                {nomenclature.is_shared ? null : (
                    <AddRule nomenclature={nomenclature} ruleTypes={ruleTypes} encodings={encodings} />
                )}"""
new = """                {nomenclature.is_shared ? null : (
                    <AddRule nomenclature={nomenclature} ruleTypes={ruleTypes} encodings={encodings} />
                )}

                <RuleTester nomenclature={nomenclature} />"""
assert old in s, 'card tail'
s = s.replace(old, new, 1)

s = s.replace("import { Head, useForm } from '@inertiajs/react';",
              "import { buildNomenclature, parseBarcode } from '@domain/barcode';\nimport { Head, useForm } from '@inertiajs/react';", 1)

# ── the tester ──────────────────────────────────────────────────────────────
s = s.rstrip() + """

/**
 * What a barcode would do at the till (BOF-043, BAN-488).
 *
 * The rule syntax is unforgiving and the failure is silent: a pattern one digit out matches nothing,
 * every scan of a weighed item falls through to a plain product lookup, and the first anyone notices
 * is a customer being charged for a kilo of something priced by the item. The only way to know a
 * rule is right has been to author it, deploy, and scan.
 *
 * This calls `parseBarcode` — **the register's own parser**, from the shared domain, not a
 * re-implementation of it. That is what makes the answer trustworthy: there is no second
 * interpretation of the rules that could agree here and disagree at the counter. Everything the
 * screen shows is what the till would decide, because it is the same function deciding it.
 */
function RuleTester({ nomenclature }: { nomenclature: NomenclatureRow }): JSX.Element {
    const t = useT();
    const [sample, setSample] = useState('');

    const parsed = useMemo(() => {
        const code = sample.trim();

        if (code === '') return null;

        // The domain types this by the enums it owns; the page carries the same fields as plain
        // strings because they came off the wire. The shapes match field for field.
        const built = buildNomenclature(
            {
                id: nomenclature.id,
                name: nomenclature.name,
                upc_ean_conv: nomenclature.upc_ean_conv,
                is_gs1: nomenclature.is_gs1,
            } as Parameters<typeof buildNomenclature>[0],
            nomenclature.rules.map((rule) => ({
                ...rule,
                barcode_nomenclature_id: nomenclature.id,
            })) as Parameters<typeof buildNomenclature>[1],
        );

        return parseBarcode(code, built);
    }, [sample, nomenclature]);

    const matched = parsed?.ruleId === null || parsed === null
        ? null
        : (nomenclature.rules.find((rule) => rule.id === parsed.ruleId) ?? null);

    return (
        <div className="space-y-2 rounded-pos border border-slate-200 p-3">
            <TextField
                label={t('barcode.test')}
                hint={t('barcode.testHint')}
                value={sample}
                placeholder="2100000123457"
                onChange={setSample}
            />

            {parsed === null ? null : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-slate-500">{t('barcode.testKind')}</dt>
                    <dd>
                        {matched === null ? (
                            // Not an error: an unmatched code is looked up as an ordinary product
                            // barcode, which is the right answer for most of what a venue scans.
                            <Badge tone="neutral">{t('barcode.testNoRule')}</Badge>
                        ) : (
                            <span className="flex items-center gap-2">
                                <Badge tone="ok">{parsed.kind}</Badge>
                                <span className="text-slate-600">{matched.name}</span>
                            </span>
                        )}
                    </dd>

                    <dt className="text-slate-500">{t('barcode.testCode')}</dt>
                    <dd className="font-mono text-xs">{parsed.code}</dd>

                    {parsed.value === 0 ? null : (
                        <>
                            <dt className="text-slate-500">{t('barcode.testValue')}</dt>
                            <dd className="tabular-nums">{parsed.value}</dd>
                        </>
                    )}
                </dl>
            )}
        </div>
    );
}
"""

s = s.replace("import { useState, type JSX } from 'react';",
              "import { useMemo, useState, type JSX } from 'react';", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('rule tester added')
