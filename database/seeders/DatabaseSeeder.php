<?php

declare(strict_types=1);

namespace Database\Seeders;

use Illuminate\Database\Seeder;

/**
 * The demo restaurant, "Le Bistro Numérique", in dependency order.
 *
 * Every seeder below is independently runnable with
 * `php artisan db:seed --class=CatalogSeeder`: each one resolves what it needs
 * by query and returns early when its own rows already exist. The suite assumes
 * a freshly migrated database and never truncates anything.
 */
class DatabaseSeeder extends Seeder
{
    /** @var list<class-string<Seeder>> */
    public const PIPELINE = [
        // Reference data with no owner.
        BaseDataSeeder::class,
        // The tenant, its settings and its customers.
        CompanySeeder::class,
        // VAT and fiscal positions.
        TaxSeeder::class,
        // Access control, then the people.
        RoleSeeder::class,
        TillRoleSeeder::class,
        EmployeeSeeder::class,
        // The menu (needs taxes + units of measure).
        CatalogSeeder::class,
        // Pricing rules (needs register categories + products).
        PricelistSeeder::class,
        // Registers (need pricelists, fiscal positions, products, employees).
        PosConfigSeeder::class,
        // Floors and tables (link themselves to the configs).
        RestaurantSeeder::class,
        // Preparation displays (need configs + register categories).
        KitchenSeeder::class,
        // QR / kiosk ordering (needs configs + tables).
        SelfOrderSeeder::class,
        // Loyalty programs and issued cards (need products + customers).
        LoyaltySeeder::class,
        // Thirty days of trading (needs everything above).
        DemoOrderSeeder::class,
    ];

    public function run(): void
    {
        $this->call(self::PIPELINE);
    }
}
