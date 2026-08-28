<?php

declare(strict_types=1);

namespace App\Providers;

use App\Listeners\InvalidateCatalogCache;
use App\Models\Catalog\BarcodeNomenclature;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductAttribute;
use App\Models\Catalog\ProductCategory;
use App\Models\Catalog\ProductVariant;
use App\Models\Identity\Employee;
use App\Models\Identity\MediaFile;
use App\Models\Kitchen\PrepDisplay;
use App\Models\Pos\Order;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosBill;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosNote;
use App\Models\Pos\PosPrinter;
use App\Models\Pos\PosSession;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Models\Pricing\PricelistItem;
use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
use App\Models\Restaurant\Floor;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Models\Scopes\CompanyScope;
use App\Policies\BarcodeNomenclaturePolicy;
use App\Policies\EmployeePolicy;
use App\Policies\FiscalPositionPolicy;
use App\Policies\FloorPolicy;
use App\Policies\MediaPolicy;
use App\Policies\OrderPolicy;
use App\Policies\PaymentMethodPolicy;
use App\Policies\PosBillPolicy;
use App\Policies\PosCategoryPolicy;
use App\Policies\PosConfigPolicy;
use App\Policies\PosDevicePolicy;
use App\Policies\PosNotePolicy;
use App\Policies\PrepDisplayPolicy;
use App\Policies\PricelistPolicy;
use App\Policies\PrinterPolicy;
use App\Policies\ProductAttributePolicy;
use App\Policies\ProductCategoryPolicy;
use App\Policies\ProductPolicy;
use App\Policies\SessionPolicy;
use App\Policies\TaxGroupPolicy;
use App\Policies\TaxPolicy;
use App\Services\Payment\NullProvider;
use App\Services\Payment\PaymentProvider;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Routing\Router;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

/**
 * Wiring for the POS domain: route-model binding by uuid, the payment-provider
 * seam, rate limiters, policies and Sanctum's token table.
 */
final class PosServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        /*
         * The online-payment seam (spec 02 SLF-060…079). The shipped default is
         * a stub so the whole self-order payment flow — intent, confirmation,
         * `payment_transactions`, `pos_payments`, the broadcast — is exercisable
         * before a PSP is chosen. Swapping it is one line.
         */
        $this->app->bind(PaymentProvider::class, function (): PaymentProvider {
            return match ((string) config('pos.self_order.payment_provider', 'null')) {
                default => new NullProvider,
            };
        });
    }

    public function boot(Router $router): void
    {
        /*
         * Sanctum ships its `personal_access_tokens` migration inside the
         * package and only publishes it on demand. Loading it from here keeps
         * `database/migrations` owned by the schema spec while still giving the
         * device tokens somewhere to live.
         */
        $this->loadMigrationsFrom(base_path('vendor/laravel/sanctum/database/migrations'));

        $this->bindRouteModels();
        $this->registerPolicies();
        $this->registerRateLimiters();
        $this->registerCatalogInvalidation();
    }

    /**
     * Catalog writes invalidate every register's cache (spec 03 §5.4).
     *
     * Bound to Eloquent's wildcard model events rather than to observers so
     * `app/Models` keeps holding relations, casts and scopes only — sync
     * concerns live in the service layer (docs/CONVENTIONS.md § Layering).
     */
    private function registerCatalogInvalidation(): void
    {
        foreach (['saved', 'deleted'] as $event) {
            foreach ([
                Product::class,
                ProductVariant::class,
                PosCategory::class,
                Tax::class,
                Pricelist::class,
                PricelistItem::class,
                PaymentMethod::class,
            ] as $model) {
                Event::listen("eloquent.{$event}: {$model}", InvalidateCatalogCache::class);
            }
        }
    }

    /**
     * Client-created records are addressed by **uuid**, forever. The server id
     * is a late-bound attribute the client may not even know yet
     * (docs/CONVENTIONS.md § Naming).
     */
    private function bindRouteModels(): void
    {
        Route::bind('order', fn (string $value): Order => Order::query()
            ->where('uuid', $value)
            ->orWhere('id', ctype_digit($value) ? (int) $value : 0)
            ->firstOrFail());

        Route::bind('session', fn (string $value): PosSession => PosSession::query()
            ->where('id', ctype_digit($value) ? (int) $value : 0)
            ->orWhere('uuid', $value)
            ->firstOrFail());

        // A kitchen display is addressed by its access token in the KDS URL, so
        // the screen's identity never leaks an incrementing id onto a wall.
        Route::bind('display', fn (string $value): PrepDisplay => PrepDisplay::query()
            ->where('access_token', $value)
            ->orWhere('uuid', $value)
            ->orWhere('id', ctype_digit($value) ? (int) $value : 0)
            ->firstOrFail());

        /*
         * A barcode nomenclature may be shared: `company_id` is nullable because the standard
         * EAN-13 and UPC-A nomenclatures are the same everywhere.
         *
         * `CompanyScope` compiles to `where(company_id, ?)`, which excludes NULL — so without this
         * a shared row 404s on every write, and an operator who can *see* it in the list gets "not
         * found" the moment they touch it. Resolved here so the controller can refuse it with the
         * actual reason: it belongs to every venue at once.
         */
        Route::bind('nomenclature', fn (string $value): BarcodeNomenclature => BarcodeNomenclature::query()
            ->withoutGlobalScope(CompanyScope::class)
            ->where('id', ctype_digit($value) ? (int) $value : 0)
            ->where(function ($query): void {
                $query->whereNull('company_id');

                $companyId = ActingCompany::id();

                if (is_int($companyId)) {
                    $query->orWhere('company_id', $companyId);
                } elseif ($companyId === ActingCompany::UNRESTRICTED) {
                    $query->orWhereNotNull('company_id');
                }
            })
            ->firstOrFail());

        Route::bind('table', fn (string $value): RestaurantTable => RestaurantTable::query()
            ->where('id', ctype_digit($value) ? (int) $value : 0)
            ->orWhere('uuid', $value)
            ->orWhere('identifier', $value)
            ->firstOrFail());
    }

    private function registerPolicies(): void
    {
        Gate::policy(Order::class, OrderPolicy::class);
        Gate::policy(PosSession::class, SessionPolicy::class);
        Gate::policy(PrepDisplay::class, PrepDisplayPolicy::class);
        Gate::policy(PosConfig::class, PosConfigPolicy::class);
        Gate::policy(PosPrinter::class, PrinterPolicy::class);
        Gate::policy(Floor::class, FloorPolicy::class);
        Gate::policy(PosBill::class, PosBillPolicy::class);
        Gate::policy(PosNote::class, PosNotePolicy::class);
        Gate::policy(PosCategory::class, PosCategoryPolicy::class);
        Gate::policy(Product::class, ProductPolicy::class);
        Gate::policy(ProductAttribute::class, ProductAttributePolicy::class);
        Gate::policy(ProductCategory::class, ProductCategoryPolicy::class);
        Gate::policy(Tax::class, TaxPolicy::class);
        Gate::policy(TaxGroup::class, TaxGroupPolicy::class);
        Gate::policy(PaymentMethod::class, PaymentMethodPolicy::class);
        // Registered explicitly: auto-discovery does not reach App\Models\Identity,
        // App\Models\Pricing or App\Models\Pos, and a policy nothing registers fails open.
        Gate::policy(Employee::class, EmployeePolicy::class);
        Gate::policy(Pricelist::class, PricelistPolicy::class);
        Gate::policy(PosDevice::class, PosDevicePolicy::class);
        Gate::policy(MediaFile::class, MediaPolicy::class);
        Gate::policy(BarcodeNomenclature::class, BarcodeNomenclaturePolicy::class);
        Gate::policy(FiscalPosition::class, FiscalPositionPolicy::class);
    }

    private function registerRateLimiters(): void
    {
        /*
         * The anonymous self-order surface is the only public write path in the
         * system, so it is throttled per IP *and* per config: a scripted client
         * hammering one venue must not be able to degrade another's service.
         */
        RateLimiter::for('self-order', function (Request $request): array {
            [$attempts, $minutes] = array_pad(
                explode(',', (string) config('pos.self_order.throttle', '60,1')),
                2,
                '1',
            );

            $configToken = (string) ($request->route('configToken') ?? 'unknown');

            return [
                Limit::perMinutes((int) $minutes, (int) $attempts)->by($request->ip().'|'.$configToken),
                Limit::perMinutes((int) $minutes, (int) $attempts * 10)->by('config:'.$configToken),
            ];
        });

        RateLimiter::for('api', fn (Request $request): Limit => Limit::perMinute(600)->by(
            $request->bearerToken() ?? $request->ip() ?? 'anonymous'
        ));
    }
}
