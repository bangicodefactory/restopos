import io

# ── the importer must do what the controller does, not just insert a row ────
p = 'app/Support/Import/Importers.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    /**
     * Columns the entity needs that no file supplies.
     *
     * `taxes.tax_group_id` is NOT NULL and there is no sensible way to name a group in a CSV, so a
     * tax lands in the venue's first group. Stated here rather than defaulted silently inside the
     * writer, because it is a real editorial decision the operator will need to correct.
     *
     * @return array<string, mixed>
     */
    public static function defaultsFor(string $entity, int $companyId): array
    {
        return match ($entity) {
            'taxes' => [
                'tax_group_id' => TaxGroup::query()->orderBy('sequence')->value('id'),
            ],
            default => [],
        };
    }
}"""

new = """    /**
     * Columns the entity needs that no file supplies.
     *
     * A CSV cannot carry a uuid or a unit of measure, and both columns are NOT NULL. `taxes.tax_group_id`
     * is the same: there is no sensible way to name a group in a CSV, so a tax lands in the venue's
     * first one. Stated here rather than defaulted silently inside the writer, because it is a real
     * editorial decision the operator will need to correct afterwards.
     *
     * @return array<string, mixed>
     */
    public static function defaultsFor(string $entity, int $companyId): array
    {
        return match ($entity) {
            'products' => [
                'uuid' => (string) Str::uuid(),
                'uom_id' => self::defaultUom(),
            ],

            'customers' => ['uuid' => (string) Str::uuid()],

            'taxes' => [
                'tax_group_id' => TaxGroup::query()->orderBy('sequence')->value('id'),
            ],

            default => [],
        };
    }

    /**
     * What has to happen after a row is created, beyond the row itself.
     *
     * A product **must** get its default variant here. `ProductController::store` creates one in the
     * same transaction, and the reason is not tidiness: the register sells variants, not products, so
     * a product imported without one is in the catalogue, visible in the back office, and cannot be
     * rung up at all. An importer that only inserted the `products` row would produce a 300-item menu
     * where nothing is sellable — and every screen would say it had worked.
     */
    public static function afterCreate(string $entity, Model $record, int $companyId): void
    {
        if ($entity !== 'products') {
            return;
        }

        /** @var Product $record */
        $record->variants()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $companyId,
            'display_name' => (string) $record->name,
            'list_price' => (string) $record->list_price,
            'active' => true,
        ]);
    }

    /** The venue's reference unit, or any unit at all. Mirrors `ProductController::defaultUom()`. */
    private static function defaultUom(): int
    {
        $id = Uom::query()->where('uom_type', UomType::Reference->value)->orderBy('id')->value('id')
            ?? Uom::query()->orderBy('id')->value('id');

        if ($id === null) {
            throw ValidationException::withMessages([
                'file' => 'This venue has no units of measure configured, so no product can be'
                    .' created. Add one first — nothing was imported.',
            ]);
        }

        return (int) $id;
    }
}"""

assert old in s
s = s.replace(old, new, 1)

for imp in (
    'use App' + chr(92) + 'Enums' + chr(92) + 'UomType;',
    'use App' + chr(92) + 'Models' + chr(92) + 'Catalog' + chr(92) + 'Uom;',
    'use Illuminate' + chr(92) + 'Database' + chr(92) + 'Eloquent' + chr(92) + 'Model;',
    'use Illuminate' + chr(92) + 'Support' + chr(92) + 'Str;',
    'use Illuminate' + chr(92) + 'Validation' + chr(92) + 'ValidationException;',
):
    if imp not in s:
        i = s.index('use App' + chr(92) + 'Http' + chr(92) + 'Requests')
        s = s[:i] + imp + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the service calls the hook ──────────────────────────────────────────────
p = 'app/Services/Import/CatalogImportService.php'
s = io.open(p, encoding='utf-8', newline='').read()
old = "                $model::query()->create([...$defaults, ...$row->values, 'company_id' => $companyId]);"
assert old in s
s = s.replace(old, """                $record = $model::query()->create([
                    // Fresh per row: a uuid is unique per record, so hoisting the defaults out of
                    // the loop would give every product in the file the same one.
                    ...Importers::defaultsFor($entity, $companyId),
                    ...$row->values,
                    'company_id' => $companyId,
                ]);

                Importers::afterCreate($entity, $record, $companyId);""", 1)

old2 = """        $spec = Importers::all()[$entity];
        $model = $spec['model'];
        $defaults = Importers::defaultsFor($entity, $companyId);

        DB::transaction(function () use ($plan, $model, $companyId, $defaults): void {"""
assert old2 in s
s = s.replace(old2, """        $model = Importers::all()[$entity]['model'];

        DB::transaction(function () use ($plan, $entity, $model, $companyId): void {""", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
