<?php

declare(strict_types=1);

namespace App\Services\Kitchen;

use App\Enums\PrepChangeType;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Services\Kitchen\Dto\PreparationChange;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;

/**
 * Turns a routed change set into a printable ticket (spec 02 KDS-055, spec 03
 * §7.1).
 *
 * We produce a **document IR** (`payload`) and a plain-text rendering, not a
 * rasterised canvas: 200–600 ms per print and 30–80 kB per receipt is what the
 * canvas approach costs, and it needs `document` and loaded fonts, which a
 * queue worker does not have. The IR is what the client's ESC/POS builder and
 * the server-side worker both consume.
 */
final readonly class TicketRenderer
{
    public function __construct(
        private ConnectionInterface $connection,
        private Config $config,
    ) {}

    /**
     * The serialisable ticket document.
     *
     * @param  list<PreparationChange>  $changes
     * @return array<string, mixed>
     */
    public function payload(Order $order, PosConfig $config, object $printer, array $changes, PrepChangeType $type): array
    {
        return [
            'v' => 1,
            'kind' => $type->value,
            'printer' => [
                'id' => (int) $printer->id,
                'name' => (string) $printer->name,
                'characters_per_line' => (int) ($printer->characters_per_line ?? $this->config->get('pos.kitchen.characters_per_line', 42)),
            ],
            'header' => [
                'station' => (string) $printer->name,
                'config' => (string) $config->name,
                'table' => $this->tableLabel($order),
                'floor' => $this->floorLabel($order),
                'guests' => (int) $order->guest_count,
                'tracking_number' => $order->tracking_number,
                'order_name' => $order->name ?? $order->receipt_number,
                'fired_at' => Carbon::now()->toIso8601ZuluString('second'),
            ],
            'courses' => $this->groupByCourse($changes),
            'notes' => array_values(array_filter([
                $order->general_customer_note,
                is_string($order->internal_note) ? $order->internal_note : null,
            ])),
        ];
    }

    /**
     * Fixed-width plain text, ready for an ESC/POS `TEXT` block. Rendered by the
     * queue worker so a slow render never blocks the ingest request.
     *
     * @param  array<string, mixed>  $payload
     */
    public function render(array $payload): string
    {
        /** @var array{characters_per_line?: int} $printer */
        $printer = (array) ($payload['printer'] ?? []);
        $width = (int) ($printer['characters_per_line'] ?? 42);

        /** @var array<string, mixed> $header */
        $header = (array) ($payload['header'] ?? []);

        $lines = [];
        $lines[] = $this->centre(strtoupper((string) ($header['station'] ?? 'KITCHEN')), $width);
        $lines[] = str_repeat('=', $width);

        $kind = (string) ($payload['kind'] ?? PrepChangeType::New->value);

        if ($kind !== PrepChangeType::New->value) {
            $lines[] = $this->centre('*** '.strtoupper(str_replace('_', ' ', $kind)).' ***', $width);
            $lines[] = str_repeat('-', $width);
        }

        if (($header['table'] ?? null) !== null) {
            $lines[] = $this->pair('Table', (string) $header['table'], $width);
        }
        if ((int) ($header['guests'] ?? 0) > 0) {
            $lines[] = $this->pair('Guests', (string) $header['guests'], $width);
        }
        if (($header['tracking_number'] ?? null) !== null) {
            $lines[] = $this->pair('Order', (string) $header['tracking_number'], $width);
        }
        $lines[] = $this->pair('Time', substr((string) ($header['fired_at'] ?? ''), 11, 8), $width);
        $lines[] = str_repeat('-', $width);

        /** @var array<int, array{index: int, lines: list<array<string, mixed>>}> $courses */
        $courses = (array) ($payload['courses'] ?? []);

        foreach ($courses as $course) {
            if (count($courses) > 1) {
                $lines[] = $this->centre('- Course '.$course['index'].' -', $width);
            }

            foreach ($course['lines'] as $line) {
                $qty = rtrim(rtrim((string) $line['quantity'], '0'), '.');
                $qty = $qty === '' || $qty === '-' ? '0' : $qty;
                $lines[] = $this->pair($qty.' x '.(string) $line['name'], '', $width);

                if (! empty($line['customer_note'])) {
                    $lines[] = '   ! '.(string) $line['customer_note'];
                }
                if (! empty($line['internal_note'])) {
                    $lines[] = '   * '.(string) $line['internal_note'];
                }
            }
        }

        /** @var list<string> $notes */
        $notes = (array) ($payload['notes'] ?? []);

        if ($notes !== []) {
            $lines[] = str_repeat('-', $width);
            foreach ($notes as $note) {
                $lines[] = wordwrap($note, $width, "\n", true);
            }
        }

        $lines[] = str_repeat('=', $width);

        return implode("\n", $lines)."\n";
    }

    /**
     * @param  list<PreparationChange>  $changes
     * @return list<array{index: int, lines: list<array<string, mixed>>}>
     */
    private function groupByCourse(array $changes): array
    {
        $grouped = [];

        foreach ($changes as $change) {
            $grouped[$change->courseIndex][] = $change->toArray();
        }

        ksort($grouped);

        $out = [];

        foreach ($grouped as $index => $lines) {
            $out[] = ['index' => (int) $index, 'lines' => $lines];
        }

        return $out;
    }

    private function tableLabel(Order $order): ?string
    {
        if ($order->restaurant_table_id === null) {
            return $order->floating_order_name;
        }

        $row = $this->connection->table('restaurant_tables')->where('id', $order->restaurant_table_id)->first(['name', 'table_number']);

        return $row === null ? null : (string) ($row->name ?? ('T '.$row->table_number));
    }

    private function floorLabel(Order $order): ?string
    {
        if ($order->restaurant_table_id === null) {
            return null;
        }

        $floorId = $this->connection->table('restaurant_tables')->where('id', $order->restaurant_table_id)->value('restaurant_floor_id');

        if ($floorId === null) {
            return null;
        }

        $name = $this->connection->table('restaurant_floors')->where('id', $floorId)->value('name');

        return $name === null ? null : (string) $name;
    }

    private function centre(string $text, int $width): string
    {
        $pad = max(0, intdiv($width - mb_strlen($text), 2));

        return str_repeat(' ', $pad).$text;
    }

    private function pair(string $left, string $right, int $width): string
    {
        $gap = max(1, $width - mb_strlen($left) - mb_strlen($right));

        return $left.str_repeat(' ', $gap).$right;
    }
}
