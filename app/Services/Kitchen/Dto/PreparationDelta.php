<?php

declare(strict_types=1);

namespace App\Services\Kitchen\Dto;

/**
 * The full "what has the kitchen not seen yet" answer for one order
 * (spec 02 KDS-051/KDS-052).
 *
 * `count` is the **signed** sum and `nbr_of_changes` the absolute one: the
 * register's badge shows the absolute number ("3 unsent changes"), while the
 * signed one tells you whether the net effect is more food or less.
 */
final readonly class PreparationDelta
{
    /** @param list<PreparationChange> $changes */
    public function __construct(
        public string $orderUuid,
        public array $changes,
        public bool $orderNoteChanged = false,
        public ?string $generalCustomerNote = null,
        public ?string $internalNote = null,
        public int $snapshotVersion = 0,
        public ?string $snapshotAt = null,
    ) {}

    public function isEmpty(): bool
    {
        return $this->changes === [] && ! $this->orderNoteChanged;
    }

    /** Absolute change count — what the register badge shows. */
    public function absoluteCount(): int
    {
        $total = 0;

        foreach ($this->changes as $change) {
            $total += (int) ceil((float) ltrim($change->quantity, '-'));
        }

        return $total;
    }

    /** Signed change count. */
    public function signedCount(): string
    {
        $total = '0';

        foreach ($this->changes as $change) {
            $total = bcadd($total, $change->quantity, 3);
        }

        return $total;
    }

    /**
     * Category routing (KDS-004 / KDS-054). `$all` short-circuits for a station
     * configured to take everything.
     *
     * @param  list<int>  $categoryIds
     * @return list<PreparationChange>
     */
    public function forCategories(array $categoryIds, bool $all = false): array
    {
        if ($all || $categoryIds === []) {
            return $all ? $this->changes : [];
        }

        return array_values(array_filter(
            $this->changes,
            static fn (PreparationChange $c): bool => $c->posCategoryId !== null && in_array($c->posCategoryId, $categoryIds, true),
        ));
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'order_uuid' => $this->orderUuid,
            'changes' => array_map(static fn (PreparationChange $c): array => $c->toArray(), $this->changes),
            'nbr_of_changes' => $this->absoluteCount(),
            'count' => $this->signedCount(),
            'order_note_changed' => $this->orderNoteChanged,
            'general_customer_note' => $this->generalCustomerNote,
            'internal_note' => $this->internalNote,
            'snapshot_version' => $this->snapshotVersion,
            'snapshot_at' => $this->snapshotAt,
        ];
    }
}
