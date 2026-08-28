/**
 * `FiscalPositions/Index` — which tax applies, and when (BOF-036, BAN-398).
 *
 * `FiscalPositionMapper` has done the rewriting correctly since it was written. There was no way to
 * create a position: no route, no controller, no page, so a venue needing takeaway VAT reached for
 * SQL.
 *
 * The one thing this screen has to say clearly is that **a mapping with no destination removes the
 * tax**. That is what an export or exempt regime is, and rendering it as an empty field would read
 * as a half-finished row rather than as the deliberate choice it is.
 */

import { Head, useForm } from '@inertiajs/react';
import { Button } from '@shared/ui';
import { useState, type JSX } from 'react';

import { SelectField, TextField, ToggleField } from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, Card, CardBody, CardHeader, EmptyState } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { routes } from '../../lib/routes';

import type { FiscalPositionsIndexProps, PositionRow } from './types';

export default function FiscalPositionsIndex({
    positions,
    taxes,
    countries,
}: FiscalPositionsIndexProps): JSX.Element {
    const t = useT();

    return (
        <AppLayout title={t('fiscal.title')} description={t('fiscal.intro')}>
            <Head title={t('fiscal.title')} />

            <div className="space-y-6">
                <AddPosition countries={countries} />

                {positions.length === 0 ? (
                    <Card>
                        <EmptyState title={t('state.empty')} hint={t('fiscal.emptyHint')} />
                    </Card>
                ) : (
                    positions.map((position) => (
                        <Position key={position.id} position={position} taxes={taxes} />
                    ))
                )}
            </div>
        </AppLayout>
    );
}

function AddPosition({ countries }: { countries: FiscalPositionsIndexProps['countries'] }): JSX.Element {
    const t = useT();
    const form = useForm<{ name: string; auto_apply: boolean; country_id: number | null }>({
        name: '',
        auto_apply: false,
        country_id: null,
    });

    return (
        <Card>
            <CardHeader title={t('fiscal.add')} description={t('fiscal.addHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('fiscal.name')}
                        value={form.data.name}
                        error={form.errors.name}
                        maxLength={96}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <ToggleField
                        label={t('fiscal.autoApply')}
                        checked={form.data.auto_apply}
                        onChange={(checked) => form.setData('auto_apply', checked)}
                        description={t('fiscal.autoApplyHint')}
                    />
                    <SelectField
                        label={t('fiscal.country')}
                        value={form.data.country_id === null ? '' : String(form.data.country_id)}
                        placeholder={t('fiscal.anyCountry')}
                        disabled={!form.data.auto_apply}
                        lockedReason={form.data.auto_apply ? undefined : t('fiscal.autoApplyFirst')}
                        options={countries.map((c) => ({ value: String(c.id), label: `${c.code} · ${c.name}` }))}
                        onChange={(value) => form.setData('country_id', value === '' ? null : Number(value))}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() => form.post(routes.fiscalPositions.store(), { onSuccess: () => form.reset() })}
                >
                    {t('fiscal.add')}
                </Button>
            </CardBody>
        </Card>
    );
}

function Position({
    position,
    taxes,
}: {
    position: PositionRow;
    taxes: FiscalPositionsIndexProps['taxes'];
}): JSX.Element {
    const t = useT();

    return (
        <Card>
            <CardHeader
                title={position.name}
                description={position.auto_apply ? t('fiscal.autoApplyOn') : t('fiscal.manualOnly')}
                actions={
                    <>
                        {position.active ? null : <Badge tone="neutral">{t('state.inactive')}</Badge>}
                        <DeleteAction
                            size="sm"
                            url={routes.fiscalPositions.destroy(position.id)}
                            name={position.name}
                        />
                    </>
                }
            />
            <CardBody className="space-y-4">
                {position.mappings.length === 0 ? (
                    <EmptyState title={t('state.empty')} hint={t('fiscal.noMappings')} />
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {position.mappings.map((mapping) => (
                            <li key={mapping.id} className="flex flex-wrap items-center gap-3 py-2">
                                <span className="min-w-40 text-slate-900">{mapping.source_name}</span>
                                <span aria-hidden className="text-slate-400">
                                    →
                                </span>
                                {/*
                                  * A removal is stated, not shown as a gap. "Removed" is what an
                                  * exempt customer is entitled to, and an empty cell here would read
                                  * as a row somebody forgot to finish.
                                  */}
                                {mapping.destination_name === null ? (
                                    <Badge tone="warn">{t('fiscal.removed')}</Badge>
                                ) : (
                                    <span className="text-slate-900">{mapping.destination_name}</span>
                                )}
                                <DeleteAction
                                    size="sm"
                                    url={routes.fiscalPositionMappings.destroy(position.id, mapping.id)}
                                    name={mapping.source_name}
                                />
                            </li>
                        ))}
                    </ul>
                )}

                <AddMapping position={position} taxes={taxes} />
            </CardBody>
        </Card>
    );
}

function AddMapping({
    position,
    taxes,
}: {
    position: PositionRow;
    taxes: FiscalPositionsIndexProps['taxes'];
}): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);
    const form = useForm<{ tax_src_id: number; tax_dest_id: number | null }>({
        tax_src_id: taxes[0]?.id ?? 0,
        tax_dest_id: null,
    });

    if (!open) {
        return (
            <Button variant="ghost" onClick={() => setOpen(true)}>
                {t('fiscal.addMapping')}
            </Button>
        );
    }

    return (
        <div className="space-y-4 rounded-pos border border-slate-200 p-4">
            <FormSection>
                <SelectField
                    label={t('fiscal.sourceTax')}
                    value={String(form.data.tax_src_id)}
                    error={form.errors.tax_src_id}
                    options={taxes.map((tax) => ({ value: String(tax.id), label: `${tax.name} (${tax.amount}%)` }))}
                    onChange={(value) => form.setData('tax_src_id', Number(value))}
                />
                <SelectField
                    label={t('fiscal.destinationTax')}
                    value={form.data.tax_dest_id === null ? '' : String(form.data.tax_dest_id)}
                    error={form.errors.tax_dest_id}
                    // The empty option is the removal, and it is labelled as such rather than left
                    // blank — see the class docblock.
                    placeholder={t('fiscal.removeEntirely')}
                    hint={t('fiscal.destinationHint')}
                    options={taxes.map((tax) => ({ value: String(tax.id), label: `${tax.name} (${tax.amount}%)` }))}
                    onChange={(value) => form.setData('tax_dest_id', value === '' ? null : Number(value))}
                />
            </FormSection>

            <div className="flex gap-2">
                <Button
                    loading={form.processing}
                    disabled={form.data.tax_src_id === 0}
                    onClick={() =>
                        form.post(routes.fiscalPositionMappings.store(position.id), {
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
