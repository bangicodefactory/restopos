<?php

declare(strict_types=1);

namespace Database\Factories\Support;

use App\Enums\CashRoundingMethod;
use App\Enums\PaymentMethodType;
use App\Enums\SymbolPosition;
use App\Enums\UomType;
use Database\Seeders\DatabaseSeeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Reference rows every factory needs but that no test wants to spell out.
 *
 * A factory is only useful if `Product::factory()->create()` works on an empty
 * database, so each accessor here returns the id of an existing row and creates
 * a minimal one when there is none. Rows are looked up by a stable name, so a
 * database seeded by {@see DatabaseSeeder} is reused rather
 * than duplicated.
 */
final class Reference
{
    public static function companyId(): int
    {
        $id = DB::table('companies')->orderBy('id')->value('id');
        if ($id !== null) {
            return (int) $id;
        }

        return (int) DB::table('companies')->insertGetId([
            'name' => 'Factory Company',
            'currency_id' => self::currencyId(),
            'timezone' => 'Europe/Paris',
            'active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public static function currencyId(string $code = 'EUR'): int
    {
        $id = DB::table('currencies')->where('code', $code)->value('id');
        if ($id !== null) {
            return (int) $id;
        }

        return (int) DB::table('currencies')->insertGetId([
            'code' => $code,
            'name' => $code,
            'symbol' => $code === 'EUR' ? '€' : $code,
            'symbol_position' => SymbolPosition::After->value,
            'decimal_places' => 2,
            'rounding' => '0.010000',
            'active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public static function uomId(): int
    {
        $id = DB::table('uoms')->orderBy('id')->value('id');
        if ($id !== null) {
            return (int) $id;
        }

        $categoryId = DB::table('uom_categories')->insertGetId([
            'name' => 'Unité', 'created_at' => now(), 'updated_at' => now(),
        ]);

        return (int) DB::table('uoms')->insertGetId([
            'uom_category_id' => $categoryId,
            'name' => 'Unité(s)',
            'uom_type' => UomType::Reference->value,
            'factor' => '1.000000000000',
            'rounding' => '1.000000',
            'is_pos_groupable' => true,
            'active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public static function taxGroupId(): int
    {
        $id = DB::table('tax_groups')->orderBy('id')->value('id');
        if ($id !== null) {
            return (int) $id;
        }

        return (int) DB::table('tax_groups')->insertGetId([
            'company_id' => self::companyId(),
            'name' => 'TVA',
            'receipt_label' => 'TVA',
            'sequence' => 10,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public static function cashRoundingId(): int
    {
        $id = DB::table('cash_roundings')->orderBy('id')->value('id');
        if ($id !== null) {
            return (int) $id;
        }

        return (int) DB::table('cash_roundings')->insertGetId([
            'company_id' => self::companyId(),
            'name' => 'Arrondi 5 centimes',
            'rounding' => '0.050000',
            'rounding_method' => CashRoundingMethod::HalfUp->value,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public static function paymentMethodId(): int
    {
        $id = DB::table('payment_methods')->orderBy('id')->value('id');
        if ($id !== null) {
            return (int) $id;
        }

        return (int) DB::table('payment_methods')->insertGetId([
            'company_id' => self::companyId(),
            'name' => 'Espèces',
            'method_type' => PaymentMethodType::Cash->value,
            'is_cash_count' => true,
            'currency_id' => self::currencyId(),
            'allow_change' => true,
            'allow_refund' => true,
            'sequence' => 10,
            'active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public static function restaurantFloorId(): int
    {
        $id = DB::table('restaurant_floors')->orderBy('id')->value('id');
        if ($id !== null) {
            return (int) $id;
        }

        return (int) DB::table('restaurant_floors')->insertGetId([
            'uuid' => (string) Str::uuid(),
            'company_id' => self::companyId(),
            'name' => 'Salle',
            'sequence' => 1,
            'table_count' => 0,
            'active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public static function posCategoryId(): ?int
    {
        $id = DB::table('pos_categories')->orderBy('id')->value('id');

        return $id === null ? null : (int) $id;
    }
}
