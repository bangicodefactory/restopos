<?php

declare(strict_types=1);

namespace App\Support\Pricing\Dto;

/**
 * §11.1 — one pickable component of a combo meal.
 *
 * `comboBasePrice` is `combos.base_price` of the owning choice group — the weight used for the
 * proportional split, NOT the component's own price. `extraPrice` is `combo_items.extra_price`
 * and is added after the split, so it never influences it.
 */
final class ComboComponent
{
    public function __construct(
        public readonly string $id,
        public readonly string $comboBasePrice,
        public readonly string $quantity = '1',
        public readonly string $extraPrice = '0',
        public readonly string $attributeExtra = '0',
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            (string) $data['id'],
            (string) ($data['comboBasePrice'] ?? '0'),
            (string) ($data['quantity'] ?? '1'),
            (string) ($data['extraPrice'] ?? '0'),
            (string) ($data['attributeExtra'] ?? '0'),
        );
    }
}
