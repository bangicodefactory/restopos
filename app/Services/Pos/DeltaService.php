<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\OrderState;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * `GET /api/pos/delta?since=&models=` — steady-state incremental pull
 * (spec 03 §3.5, spec 01-schema §5.5).
 *
 * Two things come back for every requested model: the rows whose `updated_at`
 * moved past the watermark, and the **tombstones** — rows that became invisible
 * because they were soft-deleted, archived, or left the config's scope. Hard
 * deletes are invisible to a watermark, so a client that only absorbed upserts
 * would keep a phantom product forever.
 *
 * Open orders are delta'd separately from master data: they are keyed by uuid,
 * they change constantly, and a draft order that was paid on another till is a
 * *tombstone* from this device's point of view even though the row still exists.
 */
final readonly class DeltaService
{
    public function __construct(
        private BootstrapService $bootstrap,
        private ConnectionInterface $connection,
        private Config $config,
    ) {}

    /**
     * @param  list<string>|null  $models  null = every registered model
     * @return array<string, mixed>
     */
    public function pull(PosConfig $config, PosDevice $device, string $since, ?array $models = null): array
    {
        $requested = $models === null
            ? BootstrapRegistry::names()
            : array_values(array_intersect($models, BootstrapRegistry::names()));

        $payload = $this->bootstrap->payload($config, $device, $requested, $since);

        $orders = $this->orderDelta($config, $since);

        $payload['data']['pos_orders'] = $orders['records'];
        $payload['data']['pos_order_lines'] = $orders['lines'];
        $payload['data']['pos_payments'] = $orders['payments'];
        $payload['data']['restaurant_order_courses'] = $orders['courses'];

        if ($orders['tombstones'] !== []) {
            $payload['tombstones']['pos_orders'] = $orders['tombstones'];
        }

        $payload['since'] = $since;
        $payload['has_more'] = $this->hasMore($payload);

        return $payload;
    }

    /**
     * The open-order reconciliation used on reconnect
     * (`GET /api/pos/open-orders?since=` — Odoo's `read_config_open_orders`).
     *
     * @return array<string, mixed>
     */
    public function openOrders(PosConfig $config, ?string $since = null): array
    {
        $delta = $this->orderDelta($config, $since);

        return [
            'server_time' => Carbon::now()->toIso8601ZuluString('microsecond'),
            'records' => $delta['records'],
            'lines' => $delta['lines'],
            'payments' => $delta['payments'],
            'courses' => $delta['courses'],
            'tombstones' => $delta['tombstones'],
        ];
    }

    /**
     * Draft orders on this config and its trusted peers, plus the uuids of
     * orders that left the draft set since the watermark.
     *
     * @return array{records: list<array<string, mixed>>, lines: list<array<string, mixed>>, payments: list<array<string, mixed>>, courses: list<array<string, mixed>>, tombstones: list<string>}
     */
    private function orderDelta(PosConfig $config, ?string $since): array
    {
        $configIds = [(int) $config->getKey(), ...$config->trustedConfigs()->pluck('pos_configs.id')->map(static fn (mixed $v): int => (int) $v)->all()];

        $open = $this->connection->table('pos_orders')
            ->whereIn('pos_config_id', $configIds)
            ->where('state', OrderState::Draft->value)
            ->whereNull('deleted_at')
            ->when($since !== null, fn ($q) => $q->where('updated_at', '>', Carbon::parse((string) $since)->utc()))
            ->orderBy('id')
            ->limit((int) $this->config->get('pos.bootstrap.delta_max_per_model', 500))
            ->get();

        $ids = $open->pluck('id')->map(static fn (mixed $v): int => (int) $v)->all();

        $tombstones = [];

        if ($since !== null) {
            /** @var list<string> $tombstones */
            $tombstones = $this->connection->table('pos_orders')
                ->whereIn('pos_config_id', $configIds)
                ->where('updated_at', '>', Carbon::parse($since)->utc())
                ->where(function ($q): void {
                    $q->where('state', '!=', OrderState::Draft->value)->orWhereNotNull('deleted_at');
                })
                ->pluck('uuid')
                ->map(static fn (mixed $v): string => (string) $v)
                ->all();
        }

        return [
            'records' => $this->rows($open),
            'lines' => $ids === [] ? [] : $this->rows(
                $this->connection->table('pos_order_lines')->whereIn('pos_order_id', $ids)->whereNull('deleted_at')->orderBy('id')->get()
            ),
            'payments' => $ids === [] ? [] : $this->rows(
                $this->connection->table('pos_payments')->whereIn('pos_order_id', $ids)->whereNull('deleted_at')->orderBy('id')->get()
            ),
            'courses' => $ids === [] ? [] : $this->rows(
                $this->connection->table('restaurant_order_courses')->whereIn('pos_order_id', $ids)->whereNull('deleted_at')->orderBy('course_index')->get()
            ),
            'tombstones' => $tombstones,
        ];
    }

    /**
     * @param  Collection<int, object>  $rows
     * @return list<array<string, mixed>>
     */
    private function rows(Collection $rows): array
    {
        /** @var list<array<string, mixed>> $out */
        $out = $rows->map(static fn (object $row): array => (array) $row)->values()->all();

        return $out;
    }

    /** @param array<string, mixed> $payload */
    private function hasMore(array $payload): bool
    {
        /** @var array<string, array{has_more?: bool}> $pagination */
        $pagination = (array) ($payload['pagination'] ?? []);

        foreach ($pagination as $page) {
            if (($page['has_more'] ?? false) === true) {
                return true;
            }
        }

        return false;
    }
}
