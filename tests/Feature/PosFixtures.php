<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Enums\DeviceType;
use App\Enums\PrepStageType;
use App\Enums\SessionState;
use App\Http\Middleware\HandleInertiaRequests;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
use App\Models\Catalog\Uom;
use App\Models\Catalog\UomCategory;
use App\Models\Identity\Company;
use App\Models\Identity\Employee;
use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Kitchen\PrepDisplay;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosSession;
use App\Models\Pricing\Currency;
use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
use App\Models\Restaurant\Floor;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Models\User;
use App\Services\Device\DeviceTokenService;
use App\Support\Auth\EmployeeAbilities;
use Database\Seeders\RoleSeeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use InvalidArgumentException;

/**
 * A minimal but *real* venue: one company, one currency, one 21 % tax, one
 * category, two products, a register, a paired device, an employee and an open
 * session — plus, on demand, a floor with tables and a kitchen display.
 *
 * There are no model factories in this project yet (the schema is spec-driven
 * and `database/` is owned elsewhere), so the graph is built explicitly. That is
 * verbose but it also means every test reads against the exact columns the
 * migrations declare rather than against a factory's guesses.
 */
final class PosFixtures
{
    public Company $company;

    public Currency $currency;

    public Tax $tax;

    public PosCategory $category;

    public Product $product;

    public ProductVariant $variant;

    public Product $drink;

    public ProductVariant $drinkVariant;

    public PosConfig $config;

    public PosDevice $device;

    public Employee $cashier;

    public Employee $manager;

    public PaymentMethod $cash;

    public PaymentMethod $card;

    public ?PosSession $session = null;

    public ?Floor $floor = null;

    public ?RestaurantTable $tableOne = null;

    public ?RestaurantTable $tableTwo = null;

    public ?PrepDisplay $display = null;

    public string $deviceToken = '';

    public static function make(array $configOverrides = []): self
    {
        return (new self)->build($configOverrides);
    }

    /**
     * A suffix that makes this venue's names its own.
     *
     * Empty for the first venue in a test, so the ~40 tests that assert on `Margherita` and friends
     * keep working — and non-empty for every one after it, which is the point. Two venues built from
     * the same literals are indistinguishable, so a cross-tenant assertion compares a string against
     * itself and passes whether the boundary holds or not. That is not hypothetical: the probe that
     * found the BAN-420 name disclosure printed "leak" against correct code first time, because both
     * managers were called Karim M. (BAN-508).
     *
     * Counted from the table rather than a static, so it resets with `RefreshDatabase` exactly as
     * the currency code beside it always has.
     */
    public string $suffix = '';

    /** The company name every venue is built from; the ordinal counts these and nothing else. */
    private const CompanyName = 'Trattoria Test';

    private function build(array $configOverrides): self
    {
        // Counted from the venues *this fixture* built, not from `companies` at large. A test that
        // creates a company of its own before calling `make()` would otherwise push the first venue
        // to ` #2`, and the failure — a test asserting `Margherita` breaking because of an unrelated
        // company three lines earlier — would be very hard to read.
        $venue = Company::query()->where('name', 'like', self::CompanyName.'%')->count();
        $this->suffix = $venue === 0 ? '' : ' #'.($venue + 1);

        // Currency codes are globally unique, so a second venue in the same
        // test gets its own.
        $existing = Currency::query()->count();

        $this->currency = Currency::query()->create([
            'code' => $existing === 0 ? 'EUR' : 'C'.str_pad((string) $existing, 2, '0', STR_PAD_LEFT),
            'name' => 'Euro', 'symbol' => '€',
            'decimal_places' => 2, 'rounding' => 0.01, 'active' => true,
        ]);

        $this->company = Company::query()->create([
            'name' => self::CompanyName.$this->suffix,
            'currency_id' => $this->currency->getKey(),
            'timezone' => 'UTC',
        ]);

        // Every real venue gets these from `TillRoleSeeder` (BAN-451). Seeded here for the same
        // reason: a company with no till roles is one where no employee can be given a role, so a
        // fixture without them would be testing a state no venue is ever in.
        $this->seedTillRoles();

        $group = TaxGroup::query()->create([
            'company_id' => $this->company->getKey(), 'name' => 'VAT'.$this->suffix, 'sequence' => 10,
        ]);

        $this->tax = Tax::query()->create([
            'company_id' => $this->company->getKey(),
            'tax_group_id' => $group->getKey(),
            'name' => 'VAT 21%'.$this->suffix,
            'amount_type' => 'percent',
            'amount' => 21,
            'price_include' => false,
            'sequence' => 10,
            'active' => true,
        ]);

        $uomCategory = UomCategory::query()->create(['name' => 'Unit']);
        $uom = Uom::query()->create([
            'uom_category_id' => $uomCategory->getKey(), 'name' => 'Units',
            'uom_type' => 'reference', 'factor' => 1, 'rounding' => 0.01,
        ]);

        $this->category = PosCategory::query()->create([
            'company_id' => $this->company->getKey(),
            'name' => 'Food'.$this->suffix,
            'path' => '/', 'depth' => 0, 'sequence' => 10,
        ]);

        // `pos_categories.path` is a materialised path of **ids**, terminated (BAN-422), which is
        // what makes `LIKE path%` mean "this branch" rather than "anything whose name starts the
        // same". The leading-marker workaround this replaces existed because `/Food` prefixed
        // `/Food #2` and a subtree query rooted at one venue reached into the next (BAN-508); an id
        // path cannot do that, since `/1/` is not a prefix of `/11/`.
        $this->category->forceFill(['path' => '/'.$this->category->getKey().'/'])->save();

        [$this->product, $this->variant] = $this->product('Margherita'.$this->suffix, '10.00', $uom->getKey());
        [$this->drink, $this->drinkVariant] = $this->product('Sparkling water'.$this->suffix, '2.50', $uom->getKey());

        $this->config = PosConfig::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $this->company->getKey(),
            'name' => 'Bar'.$this->suffix,
            'access_token' => PosConfig::newAccessToken(),
            'currency_id' => $this->currency->getKey(),
            'is_restaurant' => true,
            'has_cash_control' => false,
            'limited_product_count' => 100,
            'limited_customer_count' => 20,
            ...$configOverrides,
        ]);

        $this->cash = PaymentMethod::query()->create([
            'company_id' => $this->company->getKey(), 'name' => 'Cash'.$this->suffix,
            'method_type' => 'cash', 'is_cash_count' => true,
            'currency_id' => $this->currency->getKey(), 'sequence' => 10, 'active' => true,
        ]);

        $this->card = PaymentMethod::query()->create([
            'company_id' => $this->company->getKey(), 'name' => 'Card'.$this->suffix,
            'method_type' => 'card_terminal', 'is_cash_count' => false,
            'currency_id' => $this->currency->getKey(), 'sequence' => 20, 'active' => true,
        ]);

        $this->config->paymentMethods()->sync([
            $this->cash->getKey() => ['sequence' => 10],
            $this->card->getKey() => ['sequence' => 20],
        ]);

        $this->cashier = Employee::query()->create([
            'company_id' => $this->company->getKey(), 'name' => 'Amina B.'.$this->suffix,
            'default_role' => 'cashier', 'pin_hash' => hash('sha256', '1234'), 'active' => true,
        ]);

        $this->manager = Employee::query()->create([
            'company_id' => $this->company->getKey(), 'name' => 'Karim M.'.$this->suffix,
            'default_role' => 'manager', 'pin_hash' => hash('sha256', '9999'), 'active' => true,
        ]);

        $this->device = PosDevice::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_config_id' => $this->config->getKey(),
            'device_identifier' => 1,
            'name' => 'Bar terminal 1'.$this->suffix,
            'device_type' => DeviceType::Register->value,
            'active' => true,
        ]);

        $this->deviceToken = app(DeviceTokenService::class)->issue($this->device)['token'];

        return $this;
    }

    /** @return array{0: Product, 1: ProductVariant} */
    /** The three roles the product ships with, from the same config the seeder reads. */
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

    private function product(string $name, string $price, int $uomId): array
    {
        $product = Product::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $this->company->getKey(),
            'name' => $name,
            'uom_id' => $uomId,
            'list_price' => $price,
            'standard_price' => bcdiv($price, '2', 4),
            'available_in_pos' => true,
            'self_order_available' => true,
            'sale_ok' => true,
            'active' => true,
        ]);

        $variant = ProductVariant::query()->create([
            'uuid' => (string) Str::uuid(),
            'product_id' => $product->getKey(),
            'company_id' => $this->company->getKey(),
            'display_name' => $name,
            'list_price' => $price,
            'standard_price' => bcdiv($price, '2', 4),
            'active' => true,
        ]);

        $product->posCategories()->syncWithoutDetaching([$this->category->getKey()]);
        $product->taxes()->syncWithoutDetaching([$this->tax->getKey()]);
        $variant->taxes()->syncWithoutDetaching([$this->tax->getKey()]);

        return [$product, $variant];
    }

    public function withSession(string $openingFloat = '0'): self
    {
        $this->session = PosSession::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_config_id' => $this->config->getKey(),
            'company_id' => $this->company->getKey(),
            'currency_id' => $this->currency->getKey(),
            // The shape `SessionService::nextName` produces, punctuation stripped and all — a
            // fixture that hardcodes a name the application could never mint invites a test to
            // assert against an impossible value.
            'name' => (preg_replace('/[^A-Za-z0-9]/', '', (string) $this->config->name) ?: 'POS').'/00001',
            'state' => SessionState::Opened->value,
            'opened_at' => now(),
            'business_date' => now()->toDateString(),
            'cash_balance_opening' => $openingFloat,
        ]);

        return $this;
    }

    public function withFloor(): self
    {
        $this->floor = Floor::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $this->company->getKey(),
            'name' => 'Terrace'.$this->suffix,
            'sequence' => 1,
            'active' => true,
        ]);

        $this->config->floors()->syncWithoutDetaching([$this->floor->getKey()]);

        $this->tableOne = $this->table(1);
        $this->tableTwo = $this->table(2);

        return $this;
    }

    public function table(int $number): RestaurantTable
    {
        return RestaurantTable::query()->create([
            'uuid' => (string) Str::uuid(),
            'restaurant_floor_id' => $this->floor?->getKey(),
            'company_id' => $this->company->getKey(),
            'table_number' => $number,
            'name' => 'T'.$number.$this->suffix,
            'identifier' => Str::lower(Str::random(8)),
            'seats' => 4,
            'active' => true,
        ]);
    }

    public function withPrepDisplay(): self
    {
        $this->display = PrepDisplay::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $this->company->getKey(),
            'name' => 'Pass'.$this->suffix,
            'access_token' => Str::lower(Str::random(32)),
            'show_all_categories' => true,
            'active' => true,
        ]);

        $this->config->prepDisplays()->syncWithoutDetaching([$this->display->getKey()]);
        $this->config->forceFill(['use_preparation_display' => true])->save();

        foreach ([[PrepStageType::Todo, 'To do', 10], [PrepStageType::InProgress, 'Cooking', 20], [PrepStageType::Ready, 'Ready', 30]] as [$type, $name, $sequence]) {
            DB::table('prep_stages')->insert([
                'prep_display_id' => $this->display->getKey(),
                'name' => $name,
                'stage_type' => $type->value,
                'sequence' => $sequence,
                'is_default' => $sequence === 10,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        return $this;
    }

    /** @return array<string, string> */
    public function headers(array $extra = []): array
    {
        return ['Authorization' => 'Bearer '.$this->deviceToken, 'Accept' => 'application/json', ...$extra];
    }

    /**
     * Attach a `no_variant` attribute option to the fixture product and return the
     * `product_attribute_line_value` id an order line references (BAN-431 tests). Each call mints
     * its own attribute group, so options never collide on the (product, attribute) unique index.
     */
    public function attributeOption(string $name, string $priceExtra = '0', ?int $productId = null): int
    {
        $productId ??= $this->product->getKey();

        $attributeId = DB::table('product_attributes')->insertGetId([
            'company_id' => $this->company->getKey(),
            'name' => $name.' choice',
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $valueId = DB::table('product_attribute_values')->insertGetId([
            'product_attribute_id' => $attributeId,
            'name' => $name,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $lineId = DB::table('product_attribute_lines')->insertGetId([
            'product_id' => $productId,
            'product_attribute_id' => $attributeId,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        return (int) DB::table('product_attribute_line_values')->insertGetId([
            'product_attribute_line_id' => $lineId,
            'product_attribute_value_id' => $valueId,
            'product_id' => $productId,
            'price_extra' => $priceExtra,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    /**
     * A ready-made sync command for one order.
     *
     * @param  list<array<string, mixed>>  $lines
     * @return array<string, mixed>
     */
    public function orderCommand(string $uuid, array $lines = [], array $order = [], array $payments = []): array
    {
        return [
            'uuid' => $uuid,
            'op' => 'upsert',
            'order' => [
                'session_id' => $this->session?->getKey(),
                'state' => 'draft',
                'access_token' => (string) Str::uuid(),
                ...$order,
            ],
            'lines' => $lines === [] ? [[
                'op' => 'create',
                'uuid' => (string) Str::uuid(),
                'variant_id' => $this->variant->getKey(),
                'qty' => '2',
                'price_unit' => '10.00',
                'discount' => '0',
            ]] : $lines,
            'payments' => $payments,
        ];
    }

    /**
     * The asset version the Inertia middleware will compare against.
     *
     * Inertia answers 409 when the version does not match, telling the client to hard reload.
     * Computed from the middleware rather than hardcoded, so a test behaves the same on a checkout
     * with built assets and one without — omitting it passes only while `public/build` does not
     * exist, which is a trap that fires first in CI.
     */
    public static function inertiaVersion(): string
    {
        return (string) app(HandleInertiaRequests::class)->version(request());
    }

    /**
     * A back-office user of *this* company holding exactly the permissions named.
     *
     * Not a super-admin: `hasPermission` short-circuits for one, so a super-admin passes every
     * policy and proves nothing about the check under test. And not a bare `User::factory()` either
     * — that user holds no permissions, so it only passes on a route that forgot to authorize.
     *
     * Each slug is checked against `RoleSeeder::slugs()`. Tests used to mint whatever slug they
     * needed with `Permission::firstOrCreate`, which meant the suite granted permissions production
     * never creates — that is precisely why sixteen policies spent their whole life asking for
     * abilities nobody could hold, and every test still passed.
     */
    public function userWith(string ...$slugs): User
    {
        $known = RoleSeeder::slugs();

        foreach ($slugs as $slug) {
            if (! in_array($slug, $known, true)) {
                throw new InvalidArgumentException(
                    "'{$slug}' is not a permission RoleSeeder creates, so no real user could ever"
                    .' hold it. Add it to RoleSeeder::PERMISSIONS, or use the slug that exists.',
                );
            }
        }

        $role = Role::query()->create([
            'name' => 'Test role',
            'slug' => 'test-role-'.Str::random(8),
            'is_system' => false,
        ]);

        foreach ($slugs as $slug) {
            $permission = Permission::query()->firstOrCreate(
                ['slug' => $slug],
                ['group' => explode('.', $slug)[0]],
            );

            DB::table('permission_role')->insertOrIgnore([
                'role_id' => $role->getKey(),
                'permission_id' => $permission->getKey(),
            ]);
        }

        $user = User::factory()->create([
            'company_id' => $this->company->getKey(),
            'is_super_admin' => false,
        ]);

        DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

        return $user->fresh();
    }
}
