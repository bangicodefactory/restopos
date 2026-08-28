import io

p = 'resources/js/backoffice/pages/PosConfigs/Edit.tsx'
s = io.open(p, encoding='utf-8', newline='').read()

# ── the tab ────────────────────────────────────────────────────────────────
old = "        { id: 'accounting', label: t('config.group.accounting') },"
new = """        { id: 'accounting', label: t('config.group.accounting') },
        { id: 'numbering', label: t('config.group.numbering') },"""
assert old in s, 'tab anchor'
s = s.replace(old, new, 1)

# ── the body ───────────────────────────────────────────────────────────────
old = """                        {tab === 'hardware' ? ("""
new = """                        {tab === 'numbering' ? (
                            <DeferredRegion value={options} label={t('config.group.numbering')} rows={6}>
                                {(loaded) => (
                                    <div className="space-y-6">
                                        <FormSection description={t('config.numberingHint')}>
                                            <TextField
                                                label={t('config.sequencePrefix')}
                                                hint={t('config.sequencePrefixHint', {
                                                    derived: derivedPrefix(config.name),
                                                })}
                                                value={form.data.sequence_prefix ?? ''}
                                                error={form.errors.sequence_prefix}
                                                maxLength={8}
                                                onChange={(value) =>
                                                    // Empty means "derive it": the server normalises
                                                    // `''` to null, and sending null here keeps the
                                                    // dirty check honest about what will be stored.
                                                    form.setData('sequence_prefix', value === '' ? null : value)
                                                }
                                            />
                                        </FormSection>

                                        <SequenceList rows={loaded.sequences} />
                                    </div>
                                )}
                            </DeferredRegion>
                        ) : null}

                        {tab === 'hardware' ? ("""
assert old in s, 'hardware anchor'
s = s.replace(old, new, 1)

# ── the list, and the derivation the hint quotes ───────────────────────────
s = s.rstrip() + """

/**
 * What `SequenceService::prefixFor()` would derive from a register's name.
 *
 * Duplicated here on purpose and only to *show* it — the hint says what clearing the box would fall
 * back to, and a round trip to find that out would be a worse screen. The server remains the only
 * thing that decides it; if the two ever disagree the hint is wrong, which is a cosmetic failure
 * rather than a numbering one.
 */
function derivedPrefix(name: string): string {
    const stripped = name.replace(/[^A-Za-z0-9]/g, '');

    return stripped === '' ? 'POS' : stripped.slice(0, 8);
}

/**
 * The numbers this register has already issued (BOF-045).
 *
 * Read-only, and deliberately so. These are legally sequential document numbers allocated under a
 * row lock; a field that could set `next_value` would let someone reissue a receipt number a
 * customer already holds. The question an audit asks is "what comes next, and where did this one
 * come from" — which this answers without offering a way to make the answer wrong.
 */
function SequenceList({ rows }: { rows: PosConfigOptions['sequences'] }): JSX.Element {
    const t = useT();

    if (rows.length === 0) {
        return <Notice tone="info">{t('config.sequencesEmpty')}</Notice>;
    }

    return (
        <div className="space-y-2">
            <SectionTitle>{t('config.sequencesIssued')}</SectionTitle>
            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">{t('config.sequencesIssued')}</caption>
                    <thead className="bg-slate-50">
                        <tr>
                            <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                {t('config.sequencePurpose')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                {t('config.sequencePeriod')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-start text-xs uppercase text-slate-600">
                                {t('config.sequenceExample')}
                            </th>
                            <th scope="col" className="px-3 py-2 text-end text-xs uppercase text-slate-600">
                                {t('config.sequenceNext')}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {rows.map((row) => (
                            <tr key={row.id}>
                                <td className="px-3 py-1.5">{row.purpose}</td>
                                <td className="px-3 py-1.5 text-slate-500">{row.period_key ?? '—'}</td>
                                <td className="px-3 py-1.5 font-mono text-xs">
                                    {(row.prefix ?? '') + String(row.next_value).padStart(row.padding, '0')}
                                </td>
                                <td className="px-3 py-1.5 text-end tabular-nums">{row.next_value}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
"""

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('numbering group added')
