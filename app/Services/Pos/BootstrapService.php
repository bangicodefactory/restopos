<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\SessionState;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Customer;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosSession;
use App\Services\Identity\EmployeeAuthService;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * Builds the register bootstrap payload (spec 01-schema §5, spec 03 §3.2).
 *
 * The payload is a **manifest plus per-model data**, not one monolithic RPC:
 * the manifest converts "load the POS" from an opaque wait into a progress bar
 * with known denominators, lets models be fetched in parallel and makes each
 * one independently cacheable.
 *
 * Everything is scoped to the device's `pos_config`. Products and customers are
 * capped (`limited_product_count` / `limited_customer_count`) and paginated by
 * an opaque id cursor — never `OFFSET`, which skips rows on a table being
 * written to.
 */
final readonly class BootstrapService
{
    public function __construct(
        private Config $config,
        private EmployeeAuthService $employees,
    ) {}

    /**
     * The full payload: manifest + eager data + tombstones.
     *
     * @param  list<string>|null  $only  restrict to these payload keys
     * @return array<string, mixed>
     */
    public function payload(
        PosConfig $config,
        PosDevice $device,
        ?array $only = null,
        ?string $since = null,
        ?string $cursor = null,
        string $profile = PosLoadable::PROFILE_REGISTER,
    ): array {
        $serverTime = Carbon::now();
        $names = $only ?? BootstrapRegistry::names();

        $data = [];
        $tombstones = [];
        $pagination = [];

        foreach ($names as $name) {
            $class = BootstrapRegistry::classFor($name);

            if ($class === null) {
                continue;
            }

            $paginated = in_array($name, BootstrapRegistry::PAGINATED, true);
            $limit = $paginated ? $this->limitFor($name, $config) : null;

            $rows = $this->fetch($class, $config, $profile, $since, $paginated ? $cursor : null, $limit);

            $data[$name] = $rows['records'];

            if ($paginated) {
                $pagination[$name] = [
                    'cursor' => $rows['next_cursor'],
                    'has_more' => $rows['next_cursor'] !== null,
                    'limit' => $limit,
                    'total' => $rows['total'],
                ];
            }

            if ($since !== null) {
                $purged = $this->tombstones($class, $config, $profile, $since);

                if ($purged !== []) {
                    $tombstones[$name] = $purged;
                }
            }
        }

        // Synthetic entities: per-device or graph-shaped, assembled by hand.
        if ($only === null || in_array('pos_config', $only, true)) {
            $configRow = $this->configPayload($config, $profile);
            // Two shapes on purpose: self-order and the kitchen read a single object
            // (`resources/js/selforder/catalog.ts`), while the register's generic entity loader
            // (`ENTITY_TABLES.pos_configs → configs`) iterates a plural array into its `configs`
            // table — which drives `config.payment_method_ids`, pricelists, presets, etc.
            $data['pos_config'] = $configRow;
            $data['pos_configs'] = [$configRow];
        }

        if ($only === null || in_array('pos_session', $only, true)) {
            $data['pos_session'] = $this->sessionPayload($config);
        }

        if ($profile === PosLoadable::PROFILE_REGISTER && ($only === null || in_array('employees', $only, true))) {
            $data['employees'] = $this->employees->verifiersFor(
                $this->employees->candidates($config),
                $config,
                $device,
            );
        }

        return [
            'schema_version' => (int) $this->config->get('pos.api.schema_version', 1),
            'min_client_version' => (string) $this->config->get('pos.api.min_client_version', '1.0.0'),
            'profile' => $profile,
            'config_revision' => (int) $config->config_revision,
            'dataset_fingerprint' => $this->fingerprint($config),
            'server_time' => $serverTime->toIso8601ZuluString('microsecond'),
            'watermark' => $this->watermark($serverTime),
            'limits' => [
                'products' => (int) $config->limited_product_count,
                'customers' => (int) $config->limited_customer_count,
                'delta_page_size' => (int) $this->config->get('pos.bootstrap.delta_max_per_model', 500),
            ],
            'capabilities' => $this->capabilities($config),
            'pagination' => $pagination,
            'data' => $data,
            'tombstones' => $tombstones,
        ];
    }

    /**
     * The cheap manifest: per-model counts, watermarks and etags. A register
     * that re-opens minutes later compares etags and skips straight to delta.
     *
     * @return array<string, mixed>
     */
    public function manifest(PosConfig $config, PosDevice $device): array
    {
        $models = [];

        foreach (BootstrapRegistry::models() as $name => $class) {
            /** @var Builder<Model> $query */
            $query = $class::posLoadScope($config);
            $table = (new $class)->getTable();

            $count = (clone $query)->count();
            $max = (clone $query)->max($table.'.updated_at');
            $max = $max === null ? null : (string) $max;

            $models[] = [
                'name' => $name,
                'count' => $count,
                'max_updated_at' => $max,
                'etag' => $name.':'.substr(md5($name.'|'.$count.'|'.($max ?? '')), 0, 8),
                'paginated' => in_array($name, BootstrapRegistry::PAGINATED, true),
            ];
        }

        return [
            'schema_version' => (int) $this->config->get('pos.api.schema_version', 1),
            'min_client_version' => (string) $this->config->get('pos.api.min_client_version', '1.0.0'),
            'dataset_fingerprint' => $this->fingerprint($config),
            'config_revision' => (int) $config->config_revision,
            'server_time' => Carbon::now()->toIso8601ZuluString('microsecond'),
            'device' => [
                'id' => (int) $device->getKey(),
                'uuid' => (string) $device->uuid,
                'name' => $device->name,
                'device_identifier' => (int) $device->device_identifier,
                'device_type' => $device->device_type->value,
            ],
            'models' => $models,
            'capabilities' => $this->capabilities($config),
        ];
    }

    /**
     * Strong-ish ETag for the whole payload. Changes on any config edit and on
     * any catalog write, which is precisely when the client must re-read.
     */
    public function etag(PosConfig $config): string
    {
        return '"'.$this->fingerprint($config).'"';
    }

    /** `cfg{id}:r{revision}:{hash of the hot watermarks}` (spec §3.2.4). */
    public function fingerprint(PosConfig $config): string
    {
        $parts = [];

        foreach (['products', 'taxes', 'pricelist_items', 'payment_methods', 'customers'] as $name) {
            $class = BootstrapRegistry::classFor($name);

            if ($class === null) {
                continue;
            }

            $table = (new $class)->getTable();
            $parts[] = $name.'='.(string) ($class::posLoadScope($config)->max($table.'.updated_at') ?? '');
        }

        $parts[] = 'cfg='.(string) ($config->last_config_change_at?->toIso8601String() ?? '');

        return sprintf('cfg%d:r%d:%s', (int) $config->getKey(), (int) $config->config_revision, substr(md5(implode('|', $parts)), 0, 12));
    }

    /**
     * The register-visible capability flags — the client uses these to decide
     * which screens to mount before the catalog has finished loading.
     *
     * @return array<string, mixed>
     */
    public function capabilities(PosConfig $config): array
    {
        return [
            'restaurant' => (bool) $config->is_restaurant,
            'self_order' => $config->self_ordering_mode->value,
            'preparation_display' => (bool) $config->use_preparation_display,
            'preparation_printers' => (bool) $config->use_preparation_printers,
            'cash_control' => (bool) $config->has_cash_control,
            'pricelists' => (bool) $config->use_pricelists,
            'fiscal_positions' => (bool) $config->use_fiscal_positions,
            'presets' => (bool) $config->use_presets,
            'employee_login' => (bool) $config->use_employee_login,
            'loyalty' => (bool) $config->enable_loyalty,
            'tips' => (bool) $config->enable_tips,
            'split_bill' => (bool) $config->enable_split_bill,
            'global_discount' => (bool) $config->enable_global_discount,
        ];
    }

    /**
     * Lazy product search (`GET /api/pos/products?search=`) — spec §5.4.
     *
     * @return array{records: list<array<string, mixed>>, next_cursor: ?string, total: int}
     */
    public function searchProducts(PosConfig $config, ?string $search, ?int $categoryId, ?string $cursor, int $limit): array
    {
        $class = BootstrapRegistry::classFor('products');

        if ($class === null) {
            return ['records' => [], 'next_cursor' => null, 'total' => 0];
        }

        /** @var Builder<Model> $query */
        $query = $class::posLoadScope($config);
        $table = (new $class)->getTable();

        if (filled($search)) {
            $needle = '%'.str_replace(['%', '_'], ['\%', '\_'], mb_strtolower($search)).'%';
            $query->where(function (Builder $q) use ($table, $needle): void {
                $q->whereRaw('lower('.$table.'.name) like ?', [$needle])
                    ->orWhereRaw('lower(coalesce('.$table.'.default_code, \'\')) like ?', [$needle])
                    ->orWhereRaw('lower(coalesce('.$table.'.barcode, \'\')) like ?', [$needle]);
            });
        }

        if ($categoryId !== null) {
            $query->whereHas('posCategories', fn (Builder $q) => $q->whereKey($categoryId));
        }

        return $this->paginate($query, $class, PosLoadable::PROFILE_REGISTER, $cursor, $limit);
    }

    /**
     * Lazy customer search (`GET /api/pos/customers?search=`) — spec §5.4.
     *
     * @return array{records: list<array<string, mixed>>, next_cursor: ?string, total: int}
     */
    public function searchCustomers(PosConfig $config, ?string $search, ?string $cursor, int $limit): array
    {
        /** @var Builder<Customer> $query */
        $query = Customer::posLoadScope($config);

        if (filled($search)) {
            $needle = '%'.str_replace(['%', '_'], ['\%', '\_'], mb_strtolower($search)).'%';
            $digits = preg_replace('/\D+/', '', $search) ?? '';

            $query->where(function (Builder $q) use ($needle, $digits): void {
                $q->whereRaw('lower(customers.name) like ?', [$needle])
                    ->orWhereRaw('lower(coalesce(customers.email, \'\')) like ?', [$needle])
                    ->orWhereRaw('lower(coalesce(customers.vat, \'\')) like ?', [$needle]);

                if ($digits !== '') {
                    $q->orWhere('customers.phone', 'like', '%'.$digits.'%')
                        ->orWhere('customers.mobile', 'like', '%'.$digits.'%');
                }
            });
        }

        return $this->paginate($query, Customer::class, PosLoadable::PROFILE_REGISTER, $cursor, $limit);
    }

    // ------------------------------------------------------------------ internals

    /**
     * @param  class-string<PosLoadable>  $class
     * @return array{records: list<array<string, mixed>>, next_cursor: ?string, total: int}
     */
    private function fetch(string $class, PosConfig $config, string $profile, ?string $since, ?string $cursor, ?int $limit): array
    {
        /** @var Builder<Model> $query */
        $query = $class::posLoadScope($config, $profile);

        if ($since !== null && ! in_array($class::posLoadName(), BootstrapRegistry::ALWAYS_FULL, true)) {
            $query->where((new $class)->getTable().'.updated_at', '>', $this->parseSince($since));
        }

        if ($limit === null) {
            return [
                'records' => $this->select($query, $class, $profile)->map($this->rowMapper())->values()->all(),
                'next_cursor' => null,
                'total' => 0,
            ];
        }

        return $this->paginate($query, $class, $profile, $cursor, $limit);
    }

    /**
     * Cursor pagination on the primary key. Stable under concurrent writes,
     * unlike OFFSET (spec §3.2.2).
     *
     * @param  Builder<Model>  $query
     * @param  class-string<PosLoadable>  $class
     * @return array{records: list<array<string, mixed>>, next_cursor: ?string, total: int}
     */
    private function paginate(Builder $query, string $class, string $profile, ?string $cursor, int $limit): array
    {
        $table = (new $class)->getTable();
        $total = (clone $query)->count();

        if ($cursor !== null && $cursor !== '') {
            $query->where($table.'.id', '>', (int) $this->decodeCursor($cursor));
        }

        $rows = $this->select($query->reorder($table.'.id')->limit($limit + 1), $class, $profile);

        $next = null;

        if ($rows->count() > $limit) {
            $rows = $rows->take($limit);
            $last = $rows->last();
            $next = $this->encodeCursor((string) (is_array($last) ? $last['id'] : $last->getKey()));
        }

        return [
            'records' => $rows->map($this->rowMapper())->values()->all(),
            'next_cursor' => $next,
            'total' => $total,
        ];
    }

    /**
     * @param  Builder<Model>  $query
     * @param  class-string<PosLoadable>  $class
     * @return Collection<int, Model>
     */
    private function select(Builder $query, string $class, string $profile): Collection
    {
        $fields = $class::posLoadFields($profile);
        $table = (new $class)->getTable();

        if ($fields !== ['*']) {
            $columns = array_values(array_unique(['id', ...$fields]));
            $query->select(array_map(static fn (string $c): string => $table.'.'.$c, $columns));
        }

        /** @var Collection<int, Model> $rows */
        $rows = $query->get();

        return $rows;
    }

    /** @return callable(Model): array<string, mixed> */
    private function rowMapper(): callable
    {
        return static function (Model $model): array {
            /** @var array<string, mixed> $row */
            $row = $model->attributesToArray();

            // A model may rename/coerce its columns to the field names the client reads
            // (e.g. Table maps `restaurant_floor_id` → `floor_id`). Keeps the DB column names
            // out of the client contract without a Dexie schema migration.
            if (method_exists($model, 'toPosRow')) {
                /** @var array<string, mixed> $row */
                $row = $model->toPosRow($row);
            }

            return $row;
        };
    }

    /**
     * Rows the client must purge: soft-deleted or archived since the watermark
     * (spec 01-schema §5.5). Keyed by uuid for client-creatable records, by id
     * for master data.
     *
     * @param  class-string<PosLoadable>  $class
     * @return list<int|string>
     */
    private function tombstones(string $class, PosConfig $config, string $profile, string $since): array
    {
        $model = new $class;
        $table = $model->getTable();
        $columns = $model->getConnection()->getSchemaBuilder()->getColumnListing($table);

        // Deliberately *not* `posLoadScope()`: that scope filters archived and
        // out-of-domain rows out, which is exactly the set we are looking for.
        // A row that just left the config's domain is a purge from the client's
        // point of view even though the record still exists (Odoo's
        // `filter_local_data`). Scoping is therefore only by company; sending a
        // tombstone for a row the client never held is harmless.
        /** @var Builder<Model> $query */
        $query = $class::query();

        if (in_array('company_id', $columns, true)) {
            $query->where($table.'.company_id', $config->company_id);
        }

        if (in_array(SoftDeletes::class, class_uses_recursive($class), true)) {
            /** @phpstan-ignore-next-line withTrashed() exists on SoftDeletes builders */
            $query->withTrashed();
        }

        $query->where($table.'.updated_at', '>', $this->parseSince($since))
            ->where(function (Builder $q) use ($columns, $table): void {
                if (in_array('deleted_at', $columns, true)) {
                    $q->orWhereNotNull($table.'.deleted_at');
                }
                if (in_array('active', $columns, true)) {
                    $q->orWhere($table.'.active', false);
                }
                // Nothing purgeable on this entity: force an empty result.
                $q->orWhereRaw('1 = 0');
            });

        // Master data is keyed by **id** in the tombstone map; only the
        // client-creatable records (orders, lines, payments, courses) are keyed
        // by uuid, and those never come through this registry — `DeltaService`
        // owns them (spec 01-schema §5.8). A product row does carry a uuid, but
        // the client has always known it by id.
        $key = 'id';

        /** @var list<int|string> $ids */
        $ids = $query->pluck($table.'.'.$key)->all();

        return $ids;
    }

    /** @return array<string, mixed> */
    private function configPayload(PosConfig $config, string $profile): array
    {
        $row = $config->attributesToArray();

        if ($profile === PosLoadable::PROFILE_REGISTER) {
            // The register needs the token for the self-order QR + channel name.
            $row['access_token'] = $config->access_token;
        }

        $row['payment_method_ids'] = $config->paymentMethods()->pluck('payment_methods.id')->all();
        $row['pricelist_ids'] = $config->pricelists()->pluck('pricelists.id')->all();
        $row['fiscal_position_ids'] = $config->fiscalPositions()->pluck('fiscal_positions.id')->all();
        $row['preset_ids'] = $config->presets()->pluck('pos_presets.id')->all();
        $row['printer_ids'] = $config->printers()->pluck('pos_printers.id')->all();
        $row['note_ids'] = $config->notes()->pluck('pos_notes.id')->all();
        $row['bill_ids'] = $config->bills()->pluck('pos_bills.id')->all();
        $row['trusted_config_ids'] = $config->trustedConfigs()->pluck('pos_configs.id')->all();
        $row['channel'] = $config->channelName();

        return $row;
    }

    /** @return array<string, mixed>|null */
    private function sessionPayload(PosConfig $config): ?array
    {
        /** @var PosSession|null $session */
        $session = $config->currentSession()->first();

        if ($session === null) {
            return null;
        }

        $row = $session->attributesToArray();
        // Rename the column to the field the client reads (packages/domain PosSessionRow), matching
        // SessionResource on the endpoint path — one contract, the raw column name never leaks.
        $row['opening_float'] = (string) $session->cash_balance_opening;
        unset($row['cash_balance_opening']);

        return $row;
    }

    private function limitFor(string $name, PosConfig $config): int
    {
        return match ($name) {
            'products' => max(1, (int) $config->limited_product_count),
            'customers' => max(1, (int) $config->limited_customer_count),
            default => (int) $this->config->get('pos.bootstrap.product_page_size', 1000),
        };
    }

    /**
     * The next `since` value: server time minus a one-second safety margin, so
     * a row written in the same instant as the boundary is not lost. Upserts
     * are idempotent, so the overlap costs nothing (spec §3.2.4).
     */
    private function watermark(Carbon $serverTime): string
    {
        $margin = (int) $this->config->get('pos.bootstrap.watermark_safety_seconds', 1);

        return $serverTime->copy()->subSeconds($margin)->toIso8601ZuluString('microsecond');
    }

    /**
     * Watermarks arrive as ISO-8601 strings with an offset; the database stores
     * naive UTC datetimes. Comparing the two as *strings* silently never
     * matches (`'2026-07-28 16:00:00' > '2026-07-28T15:59:00+00:00'` is false
     * because a space sorts before `T`), which produces an eternally empty
     * delta — the most expensive kind of bug, because nothing errors.
     */
    private function parseSince(string $since): Carbon
    {
        return Carbon::parse($since)->utc();
    }

    private function encodeCursor(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private function decodeCursor(string $cursor): string
    {
        $decoded = base64_decode(strtr($cursor, '-_', '+/'), true);

        return $decoded === false ? '0' : $decoded;
    }

    /** Convenience for the self-order profile: is ordering actually open? */
    public function selfOrderOpen(PosConfig $config): bool
    {
        return $config->self_ordering_mode->allowsOrdering()
            && $config->currentSession()->where('state', SessionState::Opened->value)->exists();
    }
}
