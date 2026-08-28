<?php

declare(strict_types=1);

namespace App\Support\Import;

use App\Enums\ProductType;
use App\Models\Catalog\ProductCategory;
use App\Models\Catalog\Uom;
use App\Models\Identity\MediaFile;
use App\Models\Scopes\CompanyScope;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * The rules a product row must satisfy, wherever it comes from (BOF-093, BAN-491).
 *
 * These lived inside `ProductController::validated()` and were private to it. They are lifted here
 * unchanged so the importer and the interactive form cannot drift apart: an import that validated
 * more loosely than the screen would be a second, quieter way into the catalogue — which is the one
 * thing an importer must not be. The ticket asks for exactly this, and it is the reason the extract
 * came before the feature.
 *
 * Nothing about the rules changed in the move. `ProductController` now calls this and keeps its own
 * `validated()` wrapper for the request-shaped concerns around it.
 */
final class ProductRules
{
    /**
     * @return array<string, mixed>
     */
    public static function forValidator(bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        return [
            'name' => [$required, 'string', 'max:200'],
            // The upload pipeline exists now (BAN-393). Scoped through the model rather than
            // `Rule::exists`, because `media_files` carries a `company_id` and `Rule::exists` runs
            // on the query builder — the one place `CompanyScope` cannot reach. A NULL company is a
            // genuinely shared asset and stays allowed.
            'image_media_id' => ['sometimes', 'nullable', 'integer', static function (string $attribute, mixed $value, callable $fail): void {
                if ($value === null) {
                    return;
                }

                $ours = MediaFile::query()->whereKey((int) $value)->exists()
                    || MediaFile::query()
                        ->withoutGlobalScope(CompanyScope::class)
                        ->whereKey((int) $value)
                        ->whereNull('company_id')
                        ->exists();

                if (! $ours) {
                    $fail('That image belongs to another venue, or no longer exists.');
                }
            }],

            'default_code' => ['sometimes', 'nullable', 'string', 'max:64'],
            'barcode' => ['sometimes', 'nullable', 'string', 'max:64'],
            'list_price' => ['sometimes', 'numeric', 'min:0'],
            'standard_price' => ['sometimes', 'numeric', 'min:0'],

            'product_type' => ['sometimes', Rule::enum(ProductType::class)],
            'product_category_id' => ['sometimes', 'nullable', 'integer'],
            // `products.uom_id` is NOT NULL, so this is not optional the way the nullable columns
            // beside it are — it is defaulted rather than demanded. See `ProductController::defaultUom()`.
            'uom_id' => ['sometimes', 'integer'],

            'available_in_pos' => ['sometimes', 'boolean'],
            'self_order_available' => ['sometimes', 'boolean'],
            'sale_ok' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],

            // Sold by weight: the register reads a quantity from the scale instead of counting units.
            'to_weight' => ['sometimes', 'boolean'],
            'track_stock' => ['sometimes', 'boolean'],
            'allow_negative_stock' => ['sometimes', 'boolean'],

            'description_sale' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'public_description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'internal_note' => ['sometimes', 'nullable', 'string', 'max:2000'],

            'color' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'pos_sequence' => ['sometimes', 'integer'],
            'is_favorite' => ['sometimes', 'boolean'],

            'pos_category_ids' => ['sometimes', 'array'],
            'pos_category_ids.*' => ['integer'],
            'tax_ids' => ['sometimes', 'array'],
            'tax_ids.*' => ['integer'],
        ];
    }

    /**
     * The ownership checks the rule array cannot express.
     *
     * Resolved through the scoped models rather than with `exists` rules, which run unscoped and
     * would pass for another tenant's row.
     *
     * @param  array<string, mixed>  $data
     */
    public static function assertReferencesAreOurs(array $data): void
    {
        foreach (['product_category_id' => ProductCategory::class, 'uom_id' => Uom::class] as $key => $model) {
            if (! empty($data[$key]) && ! $model::query()->whereKey((int) $data[$key])->exists()) {
                throw ValidationException::withMessages([$key => 'No such record.']);
            }
        }
    }
}
