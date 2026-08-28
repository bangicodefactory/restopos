<?php

declare(strict_types=1);

namespace App\Support\Import;

use App\Enums\UomType;
use App\Http\Requests\Backoffice\CustomerRequest;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\Uom;
use App\Models\Identity\Customer;
use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
use App\Services\Catalog\CategoryTree;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Illuminate\Validation\Validator;

/**
 * What each importable entity is, in one place (BOF-093, BAN-491).
 *
 * An entry says four things:
 *
 *  - **`model`** — what is written
 *  - **`keys`** — the columns that decide *this row is that record*, tried in order. This is what
 *    makes a re-import idempotent: fix three rows of a 300-row file, upload the whole file again,
 *    and 297 rows update in place instead of creating a second catalogue.
 *  - **`rules`** — the same rules the interactive form uses, so the two cannot drift
 *  - **`columns`** — what the operator may map to, which is also the template they download
 *
 * ## Why the keys are ordered rather than combined
 *
 * A product is matched on `default_code` first and `barcode` second, because an internal reference
 * is chosen by the venue and a barcode is chosen by the manufacturer: two genuinely different
 * products can share a blank barcode, and none share a reference. Matching on both at once would
 * merge them.
 *
 * Blank key values never match. Otherwise the first row without a reference would claim every other
 * row without one, and a 300-line menu would import as a single product.
 */
final class Importers
{
    /**
     * @return array<string, array{
     *     model: class-string,
     *     label: string,
     *     keys: list<string>,
     *     columns: list<string>,
     *     required: list<string>,
     * }>
     */
    public static function all(): array
    {
        return [
            'products' => [
                'model' => Product::class,
                'label' => 'Products',
                'keys' => ['default_code', 'barcode'],
                'columns' => [
                    'name', 'default_code', 'barcode', 'list_price', 'standard_price',
                    'product_type', 'available_in_pos', 'self_order_available', 'sale_ok',
                    'to_weight', 'track_stock', 'description_sale', 'public_description',
                    'pos_sequence', 'active',
                ],
                'required' => ['name'],
            ],

            'pos_categories' => [
                'model' => PosCategory::class,
                'label' => 'POS categories',
                // A category has no reference column of its own, so the name is the key. That is
                // weaker than a reference and it is stated on the screen: renaming a category in the
                // file creates a second one rather than renaming the first.
                'keys' => ['name'],
                'columns' => ['name', 'sequence', 'color', 'active'],
                'required' => ['name'],
            ],

            'customers' => [
                'model' => Customer::class,
                'label' => 'Customers',
                'keys' => ['barcode', 'email', 'phone'],
                'columns' => [
                    'name', 'email', 'phone', 'mobile', 'vat', 'street', 'street2', 'zip', 'city',
                    'barcode', 'marketing_opt_in', 'note', 'active',
                ],
                'required' => ['name'],
            ],

            'taxes' => [
                'model' => Tax::class,
                'label' => 'Taxes',
                'keys' => ['name'],
                'columns' => ['name', 'amount', 'amount_type', 'price_include', 'sequence', 'active'],
                'required' => ['name', 'amount'],
            ],
        ];
    }

    /**
     * The rules one row of this entity must satisfy.
     *
     * Products and customers reuse the exact rule sets the interactive screens use — that is the
     * point of the ticket, and the reason `ProductRules` was lifted out of `ProductController`
     * before any of this was written.
     *
     * Taxes and POS categories have no extracted rule set to share yet; theirs are stated here and
     * are deliberately the same shape as their controllers'. That is a weaker guarantee than the
     * other two have, and it is worth naming rather than glossing: if either controller's rules
     * change, these have to change with them.
     *
     * @return array<string, mixed>
     */
    public static function rulesFor(string $entity, bool $creating): array
    {
        return match ($entity) {
            'products' => ProductRules::forValidator($creating),

            'customers' => (new CustomerRequest)->rules(),

            'pos_categories' => [
                'name' => [$creating ? 'required' : 'sometimes', 'string', 'max:96'],
                'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
                'color' => ['sometimes', 'integer', 'min:0', 'max:255'],
                'active' => ['sometimes', 'boolean'],
            ],

            'taxes' => [
                'name' => [$creating ? 'required' : 'sometimes', 'string', 'max:96'],
                'amount' => [$creating ? 'required' : 'sometimes', 'numeric'],
                'amount_type' => ['sometimes', 'string', 'in:percent,fixed,group,division'],
                'price_include' => ['sometimes', 'boolean'],
                'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
                'active' => ['sometimes', 'boolean'],
            ],

            default => [],
        };
    }

    /**
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

            // `pos_categories.path` is the materialised path and is NOT NULL, but the real one
            // contains this row's own id — which does not exist yet. `CategoryController` writes the
            // same placeholder and then calls the tree service; so does `afterCreate` below.
            'pos_categories' => ['path' => '/', 'depth' => 0],

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
        $record->variants()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $companyId,
            'display_name' => (string) $record->name,
            'list_price' => (string) $record->list_price,
            'active' => true,
        ]);
    }

    /**
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
}
