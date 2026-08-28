/**
 * `BarcodeNomenclatures/Index` — how a venue reads its own shelf labels (BOF-043, BAN-488).
 *
 * The tables, models and enums have existed since the catalogue schema was written. There was no
 * route, no controller and no page, so a venue that prints weight into its barcodes could only get
 * the rules in by seeding them.
 *
 * Two things this screen says out loud that the data model only implies:
 *
 *  1. **Rule order decides which rule wins** on a barcode more than one of them matches, so the
 *     rules are shown in that order and a new one is appended rather than inserted.
 *  2. **A shared nomenclature is not editable here.** The standard EAN-13 and UPC-A rows belong to
 *     every venue at once, so the controls are absent rather than disabled — a greyed field reads
 *     as a permission you might be granted, and this is not one.
 */

import { buildNomenclature, parseBarcode } from '@domain/barcode';
import { Head, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { SelectField, TextField, ToggleField } from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import type { BarcodeNomenclaturesIndexProps, NomenclatureRow, Option } from './types';

export default function BarcodeNomenclaturesIndex({
    nomenclatures,
    rule_types,
    encodings,
    conversions,
}: BarcodeNomenclaturesIndexProps): JSX.Element {
    const t = useT();

    return (
        <AppLayout title={t('barcode.title')} description={t('barcode.intro')}>
            <Head title={t('barcode.title')} />

            <div className="space-y-6">
                <AddNomenclature conversions={conversions} />

                {nomenclatures.length === 0 ? (
                    <Card>
                        <EmptyState title={t('state.empty')} hint={t('barcode.emptyHint')} />
                    </Card>
                ) : (
                    nomenclatures.map((nomenclature) => (
                        <Nomenclature
                            key={nomenclature.id}
                            nomenclature={nomenclature}
                            ruleTypes={rule_types}
                            encodings={encodings}
                        />
                    ))
                )}
            </div>
        </AppLayout>
    );
}

function AddNomenclature({ conversions }: { conversions: Option[] }): JSX.Element {
    const t = useT();
    const form = useForm<{ name: string; upc_ean_conv: string; is_gs1: boolean }>({
        name: '',
        upc_ean_conv: conversions[0]?.value ?? 'always',
        is_gs1: false,
    });

    return (
        <Card>
            <CardHeader title={t('barcode.add')} description={t('barcode.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('barcode.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        maxLength={64}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('barcode.upcEan')}
                        value={form.data.upc_ean_conv}
                        options={conversions}
                        hint={t('barcode.upcEanHint')}
                        onChange={(value) => form.setData('upc_ean_conv', value)}
                    />
                    <ToggleField
                        label="GS1"
                        checked={form.data.is_gs1}
                        onChange={(checked) => form.setData('is_gs1', checked)}
                        description={t('barcode.gs1Hint')}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() => form.post(routes.barcodeNomenclatures.store(), { onSuccess: () => form.reset() })}
                >
                    {t('barcode.add')}
                </Button>
            </CardBody>
        </Card>
    );
}

function Nomenclature({
    nomenclature,
    ruleTypes,
    encodings,
}: {
    nomenclature: NomenclatureRow;
    ruleTypes: Option[];
    encodings: Option[];
}): JSX.Element {
    const t = useT();

    return (
        <Card>
            <CardHeader
                title={nomenclature.name}
                description={t('barcode.ruleOrder')}
                actions={
                    <>
                        {nomenclature.is_gs1 ? <Badge tone="brand">GS1</Badge> : null}
                        {nomenclature.is_shared ? (
                            <Badge tone="neutral">{t('barcode.shared')}</Badge>
                        ) : (
                            <DeleteAction
                                size="sm"
                                url={routes.barcodeNomenclatures.destroy(nomenclature.id)}
                                name={nomenclature.name}
                            />
                        )}
                    </>
                }
            />
            <CardBody className="space-y-4">
                {nomenclature.is_shared ? <Notice tone="info">{t('barcode.sharedHint')}</Notice> : null}

                {nomenclature.rules.length === 0 ? (
                    <EmptyState title={t('state.empty')} hint={t('barcode.noRules')} />
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {nomenclature.rules.map((rule) => (
                            <li key={rule.id} className="flex flex-wrap items-center gap-3 py-2">
                                <span className="min-w-40 font-medium text-slate-900">{rule.name}</span>
                                <Badge tone="neutral">{rule.rule_type}</Badge>
                                <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs">{rule.pattern}</code>
                                {rule.active ? null : <Badge tone="warn">{t('state.inactive')}</Badge>}
                                {nomenclature.is_shared ? null : (
                                    <DeleteAction
                                        size="sm"
                                        url={routes.barcodeRules.destroy(nomenclature.id, rule.id)}
                                        name={rule.name}
                                    />
                                )}
                            </li>
                        ))}
                    </ul>
                )}

                {nomenclature.is_shared ? null : (
                    <AddRule nomenclature={nomenclature} ruleTypes={ruleTypes} encodings={encodings} />
                )}

                <RuleTester nomenclature={nomenclature} />
            </CardBody>
        </Card>
    );
}

function AddRule({
    nomenclature,
    ruleTypes,
    encodings,
}: {
    nomenclature: NomenclatureRow;
    ruleTypes: Option[];
    encodings: Option[];
}): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);
    const form = useForm<{ name: string; rule_type: string; pattern: string; encoding: string }>({
        name: '',
        rule_type: ruleTypes[0]?.value ?? '',
        pattern: '',
        encoding: encodings[0]?.value ?? '',
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('barcode.addRule')}
            </Button>
        );
    }

    return (
        <div className="space-y-4 rounded-pos border border-slate-200 p-4">
            <FormSection>
                <TextField
                    label={t('barcode.name')}
                    value={form.data.name}
                    error={form.errors.name}
                    onChange={(value) => form.setData('name', value)}
                />
                <SelectField
                    label={t('barcode.ruleType')}
                    value={form.data.rule_type}
                    error={form.errors.rule_type}
                    options={ruleTypes}
                    onChange={(value) => form.setData('rule_type', value)}
                />
                <TextField
                    label={t('barcode.pattern')}
                    value={form.data.pattern}
                    error={form.errors.pattern}
                    placeholder="21.....{NNDDD}"
                    hint={t('barcode.patternHint')}
                    onChange={(value) => form.setData('pattern', value)}
                />
                <SelectField
                    label={t('barcode.encoding')}
                    value={form.data.encoding}
                    options={encodings}
                    onChange={(value) => form.setData('encoding', value)}
                />
            </FormSection>

            <div className="flex gap-2">
                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === '' || form.data.pattern.trim() === ''}
                    onClick={() =>
                        form.post(routes.barcodeRules.store(nomenclature.id), {
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
        </div>
    );
}

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
