<?php

declare(strict_types=1);

namespace App\Support\Tax\Dto;

/**
 * §4.2 — one row of `taxes` (+ its `tax_children`), reduced to what the engine consumes.
 *
 * `includeBaseAmount` compounds FORWARD (this tax's amount joins the base of subsequent taxes);
 * `isBaseAffected` compounds BACKWARD (when false this tax ignores preceding contributions).
 * The two are independent and both are load-bearing.
 */
final class TaxDefinition
{
    public const PERCENT = 'percent';

    public const FIXED = 'fixed';

    public const DIVISION = 'division';

    public const GROUP = 'group';

    /** @param list<int> $childrenTaxIds */
    public function __construct(
        public readonly int $id,
        public readonly string $amountType,
        public readonly string $amount,
        public readonly int $sequence,
        public readonly int $taxGroupId,
        public readonly string $name = '',
        public readonly bool $priceInclude = false,
        public readonly bool $includeBaseAmount = false,
        public readonly bool $isBaseAffected = true,
        public readonly bool $hasNegativeFactor = false,
        public readonly array $childrenTaxIds = [],
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        /** @var list<int> $children */
        $children = \array_map(intval(...), (array) ($data['childrenTaxIds'] ?? []));

        return new self(
            (int) $data['id'],
            (string) ($data['amountType'] ?? self::PERCENT),
            (string) ($data['amount'] ?? '0'),
            (int) ($data['sequence'] ?? 10),
            (int) ($data['taxGroupId'] ?? 0),
            (string) ($data['name'] ?? ''),
            (bool) ($data['priceInclude'] ?? false),
            (bool) ($data['includeBaseAmount'] ?? false),
            (bool) ($data['isBaseAffected'] ?? true),
            (bool) ($data['hasNegativeFactor'] ?? false),
            $children,
        );
    }

    public function isGroup(): bool
    {
        return $this->amountType === self::GROUP;
    }
}
