import io

BS = chr(92)

# ── Importers: category placement, and the cross-field rules a FormRequest carries ──
p = 'app/Support/Import/Importers.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """            'taxes' => [
                'tax_group_id' => TaxGroup::query()->orderBy('sequence')->value('id'),
            ],

            default => [],
        };
    }"""
new = """            'taxes' => [
                'tax_group_id' => TaxGroup::query()->orderBy('sequence')->value('id'),
            ],

            // `pos_categories.path` is the materialised path and is NOT NULL, but the real one
            // contains this row's own id — which does not exist yet. `CategoryController` writes the
            // same placeholder and then calls the tree service; so does `afterCreate` below.
            'pos_categories' => ['path' => '/', 'depth' => 0],

            default => [],
        };
    }"""
assert old in s
s = s.replace(old, new, 1)

old = """    public static function afterCreate(string $entity, Model $record, int $companyId): void
    {
        if ($entity !== 'products') {
            return;
        }

        /** @var Product $record */
        $record->variants()->create(["""
new = """    public static function afterCreate(string $entity, Model $record, int $companyId): void
    {
        if ($entity === 'pos_categories') {
            // Imported categories are roots. A CSV column naming a parent would have to be resolved
            // in file order, and a file listing a child before its parent is the ordinary case — so
            // the tree is left to the interactive screen, which can show it.
            app(CategoryTree::class)->place($record, null);

            return;
        }

        if ($entity !== 'products') {
            return;
        }

        /** @var Product $record */
        $record->variants()->create(["""
assert old in s
s = s.replace(old, new, 1)

old = """    /** The venue's reference unit, or any unit at all. Mirrors `ProductController::defaultUom()`. */"""
new = """    /**
     * The checks a FormRequest carries outside its rule array.
     *
     * `rules()` alone is not the whole of what a screen enforces: `CustomerRequest` refuses marketing
     * consent on a record with no email and no mobile, and refuses a customer filed under itself, and
     * both live in `withValidator`. Reusing only the rule array would have made the import the looser
     * of the two doors — the exact thing this ticket exists to prevent, quietly reintroduced by the
     * mechanism meant to prevent it.
     *
     * @param  array<string, mixed>  $values
     */
    public static function applyCrossFieldRules(string $entity, array $values, Validator $validator): void
    {
        if ($entity !== 'customers') {
            return;
        }

        $request = CustomerRequest::create('/', 'POST', $values);
        $request->setContainer(app())->setRedirector(app('redirect'));

        $request->withValidator($validator);
    }

    /** The venue's reference unit, or any unit at all. Mirrors `ProductController::defaultUom()`. */"""
assert old in s
s = s.replace(old, new, 1)

for imp in (
    'use App' + BS + 'Services' + BS + 'Catalog' + BS + 'CategoryTree;',
    'use Illuminate' + BS + 'Validation' + BS + 'Validator;',
):
    if imp not in s:
        i = s.index('use App' + BS + 'Enums' + BS + 'UomType;')
        s = s[:i] + imp + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the service runs them ────────────────────────────────────────────────────
p = 'app/Services/Import/CatalogImportService.php'
s = io.open(p, encoding='utf-8', newline='').read()
old = """            $validator = Validator::make($values, Importers::rulesFor($entity, $existing === null));

            if ($validator->fails()) {"""
new = """            $validator = Validator::make($values, Importers::rulesFor($entity, $existing === null));

            // `rules()` is not the whole of what a screen enforces — see `applyCrossFieldRules`.
            Importers::applyCrossFieldRules($entity, $values, $validator);

            if ($validator->fails()) {"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('ok')
