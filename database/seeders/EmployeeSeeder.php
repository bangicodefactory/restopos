<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\EmployeeRole;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * The brigade: six register identities plus the two back-office logins.
 *
 * `employees.pin_hash` and `employees.barcode_hash` are `char(64)` — i.e. a hex
 * SHA-256 digest, not a bcrypt string; the register hashes the typed PIN client
 * side and compares digests, so the plaintext never travels.
 */
class EmployeeSeeder extends Seeder
{
    public const ADMIN_EMAIL = 'admin@restopos.test';

    public const MANAGER_EMAIL = 'amelie@restopos.test';

    /** @var list<array{name:string,job:string,pin:string,role:EmployeeRole,color:int,roleSlug:string,email:?string}> */
    private const STAFF = [
        [
            'name' => 'Amélie Rousseau', 'job' => 'Gérante', 'pin' => '1234',
            'role' => EmployeeRole::Manager, 'color' => 3, 'roleSlug' => 'manager',
            'email' => self::MANAGER_EMAIL,
        ],
        [
            'name' => 'Karim Benali', 'job' => 'Chef de rang', 'pin' => '2468',
            'role' => EmployeeRole::Cashier, 'color' => 5, 'roleSlug' => 'waiter',
            'email' => null,
        ],
        [
            'name' => 'Sofia Marchetti', 'job' => 'Serveuse', 'pin' => '1357',
            'role' => EmployeeRole::Cashier, 'color' => 7, 'roleSlug' => 'waiter',
            'email' => null,
        ],
        [
            'name' => 'Marc Lefèvre', 'job' => 'Caissier', 'pin' => '4321',
            'role' => EmployeeRole::Cashier, 'color' => 2, 'roleSlug' => 'cashier',
            'email' => null,
        ],
        [
            'name' => 'Léa Dubois', 'job' => 'Barmaid', 'pin' => '8642',
            'role' => EmployeeRole::Cashier, 'color' => 9, 'roleSlug' => 'cashier',
            'email' => null,
        ],
        [
            'name' => 'Youssef El Amrani', 'job' => 'Chef de cuisine', 'pin' => '9753',
            'role' => EmployeeRole::Minimal, 'color' => 1, 'roleSlug' => 'kitchen',
            'email' => null,
        ],
    ];

    public function run(): void
    {
        Demo::reseed('employees');

        $companyId = (int) DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === 0 || DB::table('employees')->where('company_id', $companyId)->exists()) {
            return;
        }

        $now = Demo::ts(Demo::clock());
        $roles = DB::table('roles')->pluck('id', 'slug');

        $adminId = $this->makeUser($companyId, 'Ahmed Chioua', self::ADMIN_EMAIL, true, $now);
        $this->attachRole((int) $roles['owner'], $adminId);

        foreach (self::STAFF as $index => $member) {
            $userId = null;
            if ($member['email'] !== null) {
                $userId = $this->makeUser($companyId, $member['name'], $member['email'], false, $now);
                $this->attachRole((int) $roles[$member['roleSlug']], $userId);
            }

            $barcode = '041'.str_pad((string) (100 + $index), 10, '0', STR_PAD_LEFT);

            DB::table('employees')->insert([
                'company_id' => $companyId,
                'user_id' => $userId,
                'name' => $member['name'],
                'job_title' => $member['job'],
                'barcode' => $barcode,
                'barcode_hash' => Demo::sha256($barcode),
                'pin_hash' => Demo::sha256($member['pin']),
                'default_role' => $member['role']->value,
                'color' => $member['color'],
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }
    }

    private function makeUser(int $companyId, string $name, string $email, bool $superAdmin, string $now): int
    {
        $existing = DB::table('users')->where('email', $email)->value('id');
        if ($existing !== null) {
            return (int) $existing;
        }

        return (int) DB::table('users')->insertGetId([
            'company_id' => $companyId,
            'name' => $name,
            'email' => $email,
            'email_verified_at' => $now,
            'password' => Hash::make('password'),
            'locale' => 'fr',
            'is_super_admin' => $superAdmin,
            'active' => true,
            'remember_token' => Demo::token('user:'.$email, 10),
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    private function attachRole(int $roleId, int $userId): void
    {
        $exists = DB::table('role_user')
            ->where('role_id', $roleId)->where('user_id', $userId)->exists();

        if (! $exists) {
            DB::table('role_user')->insert(['role_id' => $roleId, 'user_id' => $userId]);
        }
    }
}
