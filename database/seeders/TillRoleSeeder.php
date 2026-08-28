<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Support\Auth\EmployeeAbilities;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * The three till roles the product ships with (BOF-118, BAN-451).
 *
 * Seeded **from `config/pos.php`**, deliberately. That config was the only definition of these roles
 * until BAN-451, so reading it here is what makes the change invisible on migration: a venue that
 * upgrades gets exactly the abilities it had, and only then can edit them.
 *
 * The config entry stays where it is rather than being deleted. It is now the *shipping default* —
 * what a new venue starts with — and `ApprovalAuthority` no longer reads it to decide what is a real
 * ability, which was the part that could not survive editable roles (`EmployeeAbilities`).
 *
 * Filtered through the registry on the way in. If the config and the registry ever disagree, the
 * registry wins: seeding an ability nothing checks would put it in the matrix as a grantable
 * permission that does nothing.
 */
class TillRoleSeeder extends Seeder
{
    /** @var array<string, array{name: string, sequence: int}> */
    private const LABELS = [
        'minimal' => ['name' => 'Accès minimal', 'sequence' => 10],
        'cashier' => ['name' => 'Caissier', 'sequence' => 20],
        'manager' => ['name' => 'Responsable', 'sequence' => 30],
    ];

    public function run(): void
    {
        /** @var array<string, list<string>> $defaults */
        $defaults = (array) config('pos.role_abilities', []);

        $companies = DB::table('companies')->pluck('id');

        foreach ($companies as $companyId) {
            foreach ($defaults as $slug => $abilities) {
                $exists = DB::table('till_roles')
                    ->where('company_id', $companyId)
                    ->where('slug', $slug)
                    ->exists();

                if ($exists) {
                    continue;
                }

                DB::table('till_roles')->insert([
                    'company_id' => $companyId,
                    'slug' => (string) $slug,
                    'name' => self::LABELS[$slug]['name'] ?? ucfirst((string) $slug),
                    'abilities' => json_encode(EmployeeAbilities::only((array) $abilities)),
                    'is_system' => true,
                    'sequence' => self::LABELS[$slug]['sequence'] ?? 40,
                    'active' => true,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }
        }
    }
}
