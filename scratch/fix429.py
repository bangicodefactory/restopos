import io

# the placeholder strings described the screen that now exists
p = 'resources/js/backoffice/i18n/dictionary.ts'
s = io.open(p, encoding='utf-8', newline='').read()
for old in ("""    'preset.title': 'Modes de service',
    'preset.missing':
        'Aucune route back-office n’expose les modes de service (`pos_presets`) ni leurs plages horaires. Ils sont affectés depuis les paramètres du point de vente.',
    'preset.windows': 'Plages de service',

""",
            """    'preset.title': 'Presets',
    'preset.missing':
        'No back-office route exposes presets (`pos_presets`) or their service windows. They are assigned from the register settings.',
    'preset.windows': 'Service windows',

"""):
    assert old in s, 'MISSING: ' + old[:50]
    s = s.replace(old, '', 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# Edit.tsx
p = 'resources/js/backoffice/pages/Presets/Edit.tsx'
s = io.open(p, encoding='utf-8', newline='').read()


def sub(old, new):
    global s
    assert old in s, 'MISSING: ' + old[:70]
    s = s.replace(old, new, 1)


sub("const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;",
    """/**
 * The seven day keys, spelled out.
 *
 * A `t()` key is a closed union, so a template literal cannot address one — and that is the point:
 * it is what stops a missing translation reaching a screen.
 */
const DAY_LABEL = ['day.0', 'day.1', 'day.2', 'day.3', 'day.4', 'day.5', 'day.6'] as const;

const PERIOD_LABEL = {
    morning: 'period.morning',
    afternoon: 'period.afternoon',
    evening: 'period.evening',
} as const;""")

sub("""            cell: (row) => t(`day.${row.day_of_week}`),
            sortValue: (row) => row.day_of_week,
            exportValue: (row) => t(`day.${row.day_of_week}`),""",
    """            cell: (row) => t(DAY_LABEL[row.day_of_week] ?? 'day.0'),
            sortValue: (row) => row.day_of_week,
            exportValue: (row) => t(DAY_LABEL[row.day_of_week] ?? 'day.0'),""")

sub("t(`period.${row.day_period}`)", "t(PERIOD_LABEL[row.day_period])")

sub("options={DAYS.map((day) => ({ value: String(day), label: t(`day.${day}`) }))}",
    "options={DAY_LABEL.map((key, day) => ({ value: String(day), label: t(key) }))}")

sub("                                description={t('preset.identificationHint')}",
    "                                hint={t('preset.identificationHint')}")
sub("                                description={t('preset.fiscalPositionHint')}",
    "                                hint={t('preset.fiscalPositionHint')}")

sub("""                            onSave={() =>
                                form
                                    .transform((data) => ({
                                        ...data,
                                        pricelist_id: data.pricelist_id === '' ? null : Number(data.pricelist_id),
                                        fiscal_position_id:
                                            data.fiscal_position_id === '' ? null : Number(data.fiscal_position_id),
                                    }))
                                    .patch(routes.presets.update(preset.id), { preserveScroll: true })
                            }""",
    """                            onSave={() => {
                                form.transform((data) => ({
                                    ...data,
                                    pricelist_id: data.pricelist_id === '' ? null : Number(data.pricelist_id),
                                    fiscal_position_id:
                                        data.fiscal_position_id === '' ? null : Number(data.fiscal_position_id),
                                }));
                                form.patch(routes.presets.update(preset.id), { preserveScroll: true });
                            }}""")

sub("""    const form = useForm<{ day_of_week: string; from: string; to: string }>({
        day_of_week: '0',
        from: '11:00',
        to: '14:00',
    });""",
    """    // Keyed by the names that are posted, so the server's errors land on the fields that caused them.
    const form = useForm<{ day_of_week: string; hour_from: string; hour_to: string }>({
        day_of_week: '0',
        hour_from: '11:00',
        hour_to: '14:00',
    });""")

sub("""                        value={form.data.from}
                        error={form.errors.hour_from}
                        placeholder="11:00"
                        onChange={(value) => form.setData('from', value)}""",
    """                        value={form.data.hour_from}
                        error={form.errors.hour_from}
                        placeholder="11:00"
                        onChange={(value) => form.setData('hour_from', value)}""")

sub("""                        value={form.data.to}
                        error={form.errors.hour_to}
                        placeholder="14:00"
                        onChange={(value) => form.setData('to', value)}""",
    """                        value={form.data.hour_to}
                        error={form.errors.hour_to}
                        placeholder="14:00"
                        onChange={(value) => form.setData('hour_to', value)}""")

sub("""                        onClick={() =>
                            form
                                .transform((data) => ({
                                    day_of_week: Number(data.day_of_week),
                                    // `null` for an unparseable time rather than a silent 0: 0 is
                                    // midnight, which the server accepts, so a typo would save a
                                    // window opening at midnight instead of showing an error.
                                    hour_from: clockToHour(data.from),
                                    hour_to: clockToHour(data.to),
                                }))
                                .post(routes.serviceWindows.store(presetId), {
                                    preserveScroll: true,
                                    onSuccess: () => setOpen(false),
                                })
                        }""",
    """                        onClick={() => {
                            form.transform((data) => ({
                                day_of_week: Number(data.day_of_week),
                                // `null` for an unparseable time rather than a silent 0: 0 is
                                // midnight, which the server accepts, so a typo would save a window
                                // opening at midnight instead of showing an error.
                                hour_from: clockToHour(data.hour_from),
                                hour_to: clockToHour(data.hour_to),
                            }));
                            form.post(routes.serviceWindows.store(presetId), {
                                preserveScroll: true,
                                onSuccess: () => setOpen(false),
                            });
                        }}""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# Index.tsx
p = 'resources/js/backoffice/pages/Presets/Index.tsx'
s = io.open(p, encoding='utf-8', newline='').read()
old = """                        onClick={() =>
                            form
                                // An empty select means "none", and the column is nullable. Posting
                                // `''` would fail the integer rule on a field the operator left
                                // deliberately blank.
                                .transform((data) => ({
                                    ...data,
                                    pricelist_id: data.pricelist_id === '' ? null : Number(data.pricelist_id),
                                    fiscal_position_id:
                                        data.fiscal_position_id === '' ? null : Number(data.fiscal_position_id),
                                }))
                                .post(routes.presets.store(), { onSuccess: () => setOpen(false) })
                        }"""
assert old in s
s = s.replace(old, """                        onClick={() => {
                            // An empty select means "none", and the column is nullable. Posting an
                            // empty string would fail the integer rule on a field the operator left
                            // deliberately blank.
                            form.transform((data) => ({
                                ...data,
                                pricelist_id: data.pricelist_id === '' ? null : Number(data.pricelist_id),
                                fiscal_position_id:
                                    data.fiscal_position_id === '' ? null : Number(data.fiscal_position_id),
                            }));
                            form.post(routes.presets.store(), { onSuccess: () => setOpen(false) });
                        }}""", 1)
s = s.replace("            cell: (row) => t(`preset.serviceAt.${row.service_at}`),",
              "            cell: (row) => t(SERVICE_AT_LABEL[row.service_at]),", 1)
s = s.replace("            cell: (row) => t(`preset.identification.${row.identification}`),",
              "            cell: (row) => t(IDENTIFICATION_LABEL[row.identification]),", 1)
s = s.replace("export default function PresetsIndex(",
              """/** A `t()` key is a closed union, which is what stops a missing translation reaching a screen. */
const SERVICE_AT_LABEL = {
    counter: 'preset.serviceAt.counter',
    table: 'preset.serviceAt.table',
    delivery: 'preset.serviceAt.delivery',
} as const;

const IDENTIFICATION_LABEL = {
    none: 'preset.identification.none',
    name: 'preset.identification.name',
    address: 'preset.identification.address',
} as const;

export default function PresetsIndex(""", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('fixed')
