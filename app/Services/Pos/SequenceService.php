<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\OrderSource;
use App\Enums\SequencePurpose;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosSession;
use App\Models\Pos\Sequence;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Database\ConnectionInterface;

/**
 * The three server-owned numbers (spec 03 §6).
 *
 * | Number | Gapless | Scope | Assigned |
 * |---|---|---|---|
 * | `sequence_number` | **yes** | per session | at ingest |
 * | `name` (`Bar/00412`) | no | per session | at ingest |
 * | invoice number | **yes, legally** | per journal/year | at invoicing |
 *
 * The order *reference* (`26D03-3-000412`) is the client's, because it must
 * exist offline on the printed receipt; collisions are impossible by device
 * namespacing and the server only intervenes on a genuine unique violation.
 */
final readonly class SequenceService
{
    public function __construct(
        private ConnectionInterface $connection,
        private Config $config,
    ) {}

    /**
     * Gapless per-session order number. A single locked read-modify-write
     * inside the caller's ingest transaction, so a rolled-back ingest also
     * rolls back the number.
     */
    public function nextSessionSequence(PosSession $session): int
    {
        $row = $this->connection->table('pos_sessions')
            ->where('id', $session->getKey())
            ->lockForUpdate()
            ->first(['order_count']);

        $next = (int) ($row->order_count ?? 0) + 1;

        $this->connection->table('pos_sessions')
            ->where('id', $session->getKey())
            ->update(['order_count' => $next]);

        $session->setAttribute('order_count', $next);

        return $next;
    }

    /** `Bar/00412` — the human-facing order name (spec §6.2). */
    public function orderName(PosConfig $config, int $sequence): string
    {
        $padding = (int) $this->config->get('pos.sequence.order_name_padding', 5);
        $prefix = $this->prefixFor($config);

        return $prefix.'/'.str_pad((string) $sequence, $padding, '0', STR_PAD_LEFT);
    }

    /**
     * Legally sequential document numbers, allocated from the `sequences` table
     * under a row lock and never client-side (spec §6.5).
     */
    public function allocate(PosConfig $config, SequencePurpose $purpose, ?string $periodKey = null): string
    {
        /** @var Sequence $sequence */
        $sequence = Sequence::query()->firstOrCreate(
            [
                'company_id' => $config->company_id,
                'pos_config_id' => $config->getKey(),
                'purpose' => $purpose->value,
                'period_key' => $periodKey,
            ],
            [
                'prefix' => strtoupper(substr($purpose->value, 0, 3)).'/',
                'padding' => 6,
                'next_value' => 1,
            ],
        );

        return $sequence->format($sequence->allocate());
    }

    /**
     * A 5-character portal code from an unambiguous alphabet (no 0/O/1/I).
     * The client mints its own; this is the server-side regeneration path used
     * when a genuine collision hits the unique index (spec §6.4).
     */
    public function receiptToken(): string
    {
        $alphabet = (string) $this->config->get('pos.sequence.receipt_token_alphabet', '23456789ABCDEFGHJKLMNPQRSTUVWXYZ');
        $length = (int) $this->config->get('pos.sequence.receipt_token_length', 5);

        $out = '';
        for ($i = 0; $i < $length; $i++) {
            $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }

        return $out;
    }

    /**
     * Resolve a `reference` collision by suffixing, rather than failing the
     * order. Losing a real sale to a bookkeeping constraint is the worst
     * possible failure mode (spec §6.1).
     */
    public function deduplicateReference(PosConfig $config, string $reference): string
    {
        $candidate = $reference;
        $suffix = 1;

        while ($this->connection->table('pos_orders')
            ->where('pos_config_id', $config->getKey())
            ->where('receipt_number', $candidate)
            ->exists()
        ) {
            $candidate = $reference.'-R'.$suffix++;
        }

        return $candidate;
    }

    /**
     * A tracking number free in this session, preferring the one the client asked for (BAN-506).
     *
     * The number a till mints is a **proposal**, never authority. It comes from that device's own
     * local counter, minted offline where nothing can be checked, so a till paired into a session
     * that already holds `001` proposes `001` — and since BAN-470 added
     * `pos_orders_session_tracking_unique`, that used to reject the order and lose the sale. A
     * second till brought onto the counter mid-service hit it on its very first order.
     *
     * The self-order path has resolved this since BAN-470; this is the same rule, moved somewhere
     * both callers can reach so they cannot drift apart again.
     *
     * Availability is keyed on the **bare** number, so kiosk `K001` also reserves mobile `S001` and
     * register `001`. That is deliberate: the counter calls "001", and two customers answering to
     * the same call is the failure the constraint exists to prevent.
     */
    public function availableTrackingNumber(PosSession $session, ?string $preferred = null, string $prefix = ''): string
    {
        $used = [];

        // Soft-deleted rows are deliberately **not** excluded. `pos_orders_session_tracking_unique`
        // is a plain unique index with no `deleted_at` term, so a deleted order still owns its
        // number in the database; recycling it would violate the index and lose the very sale this
        // method exists to save. Filtering them out looks like an obvious improvement and is not.
        foreach (
            $this->connection->table('pos_orders')
                ->where('pos_session_id', $session->getKey())
                ->whereNotNull('tracking_number')
                ->pluck('tracking_number') as $number
        ) {
            $used[$this->bareTracking((string) $number)] = true;
        }

        $wanted = $preferred === null ? '' : $this->bareTracking(trim($preferred));

        if ($wanted !== '' && ! isset($used[$wanted])) {
            return $prefix.$wanted;
        }

        for ($n = 1; $n <= 999; $n++) {
            $candidate = str_pad((string) $n, 3, '0', STR_PAD_LEFT);

            if (! isset($used[$candidate])) {
                return $prefix.$candidate;
            }
        }

        // 999 live orders in one session is not a service, it is a data problem — but a duplicate
        // number is still better than refusing the sale.
        return $prefix.str_pad((string) random_int(1, 999), 3, '0', STR_PAD_LEFT);
    }

    /**
     * A tracking number without its source prefix.
     *
     * A prefix strip, not `ltrim`: ltrim takes a *character list*, so it would eat repeated leading
     * characters and misbehave the day a prefix becomes more than one letter.
     */
    private function bareTracking(string $number): string
    {
        foreach (OrderSource::cases() as $source) {
            $prefix = $source->trackingPrefix();

            if ($prefix !== '' && str_starts_with($number, $prefix)) {
                return substr($number, \strlen($prefix));
            }
        }

        return $number;
    }

    private function prefixFor(PosConfig $config): string
    {
        $name = preg_replace('/[^A-Za-z0-9]/', '', (string) $config->name) ?? '';

        return $name === '' ? 'POS' : substr($name, 0, 8);
    }
}
