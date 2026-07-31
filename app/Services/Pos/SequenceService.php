<?php

declare(strict_types=1);

namespace App\Services\Pos;

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

    private function prefixFor(PosConfig $config): string
    {
        $name = preg_replace('/[^A-Za-z0-9]/', '', (string) $config->name) ?? '';

        return $name === '' ? 'POS' : substr($name, 0, 8);
    }
}
