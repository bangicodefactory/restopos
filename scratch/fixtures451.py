import io

BS = chr(92)

p = 'tests/Feature/PosFixtures.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """        $this->company = Company::query()->create([
            'name' => self::CompanyName.$this->suffix,
            'currency_id' => $this->currency->getKey(),
            'timezone' => 'UTC',
        ]);"""
assert old in s, 'company anchor'
new = """        $this->company = Company::query()->create([
            'name' => self::CompanyName.$this->suffix,
            'currency_id' => $this->currency->getKey(),
            'timezone' => 'UTC',
        ]);

        // Every real venue gets these from `TillRoleSeeder` (BAN-451). Seeded here for the same
        // reason: a company with no till roles is one where no employee can be given a role, so a
        // fixture without them would be testing a state no venue is ever in.
        $this->seedTillRoles();"""
s = s.replace(old, new, 1)

old2 = """    private function product(string $name, string $price, int $uomId): array"""
assert old2 in s, 'product anchor'
new2 = """    /** The three roles the product ships with, from the same config the seeder reads. */
    private function seedTillRoles(): void
    {
        $sequence = 10;

        foreach ((array) config('pos.role_abilities', []) as $slug => $abilities) {
            DB::table('till_roles')->insert([
                'company_id' => $this->company->getKey(),
                'slug' => (string) $slug,
                'name' => ucfirst((string) $slug),
                'abilities' => json_encode(EmployeeAbilities::only((array) $abilities)),
                'is_system' => true,
                'sequence' => $sequence,
                'active' => true,
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            $sequence += 10;
        }
    }

    private function product(string $name, string $price, int $uomId): array"""
s = s.replace(old2, new2, 1)

imp = 'use App' + BS + 'Support' + BS + 'Auth' + BS + 'EmployeeAbilities;'
if imp not in s:
    i = s.index('use App' + BS)
    s = s[:i] + imp + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('fixtures seed roles')
