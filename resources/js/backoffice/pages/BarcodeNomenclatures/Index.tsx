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

import { Head, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

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
