<?php

declare(strict_types=1);

namespace App\Support\Pricing;

use App\Support\Money\Decimal;
use App\Support\Money\RoundingMode;
use App\Support\Pricing\Dto\Pricelist;
use App\Support\Pricing\Dto\PricelistContext;
use App\Support\Pricing\Dto\PricelistItem;
use DomainException;
use RuntimeException;

/**
 * §10 — pricelist rule resolution.
 *
 * Pure PHP mirror of `packages/domain/src/pricing/pricelist.ts`. Unlike Odoo it has a recursion
 * depth cap and cycle detection on `base = pricelist` (§10.5): a cyclic pricelist otherwise
 * hangs the till.
 */
final class PricelistResolver
{
    /** §10.5 */
    public const MAX_DEPTH = 5;

    /** Sentinel rank for a global rule; larger than any realistic category depth (§10.3). */
    private const GLOBAL_RANK = 1002;

    /** @var array<int, Pricelist> */
    private readonly array $pricelists;

    /** @param list<Pricelist> $pricelists */
    public function __construct(array $pricelists)
    {
        $byId = [];
        foreach ($pricelists as $pricelist) {
            $byId[$pricelist->id] = $pricelist;
        }
        $this->pricelists = $byId;
    }

    /** @param list<array<string, mixed>> $pricelists */
    public static function fromArray(array $pricelists): self
    {
        return new self(\array_map(
            static fn (array $row): Pricelist => Pricelist::fromArray($row),
            \array_values($pricelists),
        ));
    }

    /** Resolved unit price rendered at PRICE_SCALE (§10.6.4). */
    public function resolve(int $pricelistId, PricelistContext $context, string $rate = '1'): string
    {
        return $this->resolveDecimal($pricelistId, $context, $rate)
            ->withScale(Decimal::PRICE_SCALE, RoundingMode::HalfUp)
            ->toString();
    }

    public function resolveDecimal(int $pricelistId, PricelistContext $context, string $rate = '1'): Decimal
    {
        if (! $context->isRepriceable()) {
            // §10.7 — never reprice a manual or barcode-embedded price.
            return $this->basePrice($context)->mul(Decimal::of($rate));
        }

        return $this->resolveIn($pricelistId, $context, 0, [])->mul(Decimal::of($rate));
    }

    private function basePrice(PricelistContext $context): Decimal
    {
        return Decimal::of($context->listPrice)->add(Decimal::of($context->priceExtra));
    }

    /** @param array<int, true> $stack */
    private function resolveIn(int $pricelistId, PricelistContext $context, int $depth, array $stack): Decimal
    {
        if ($depth > self::MAX_DEPTH) {
            throw new RuntimeException(\sprintf('pricelist base recursion exceeds %d', self::MAX_DEPTH));
        }
        if (isset($stack[$pricelistId])) {
            throw new RuntimeException(\sprintf('cyclic pricelist base at %d', $pricelistId));
        }
        if (! isset($this->pricelists[$pricelistId])) {
            throw new DomainException(\sprintf('unknown pricelist %d', $pricelistId));
        }

        $item = $this->pick($this->pricelists[$pricelistId]->items, $context);
        if ($item === null) {
            return $this->basePrice($context);
        }

        // §10.5 — base price
        $price = match ($item->base) {
            PricelistItem::BASE_LIST_PRICE => $this->basePrice($context),
            PricelistItem::BASE_STANDARD_PRICE => Decimal::of($context->standardPrice),
            PricelistItem::BASE_PRICELIST => $item->basePricelistId === null
                ? $this->basePrice($context)
                : $this->resolveIn($item->basePricelistId, $context, $depth + 1, $stack + [$pricelistId => true]),
            default => throw new DomainException(\sprintf('unknown pricelist base "%s"', $item->base)),
        };

        // §10.6 — computation
        $hundred = Decimal::hundred();

        if ($item->computePrice === PricelistItem::COMPUTE_FIXED) {
            return Decimal::of($item->fixedPrice);
        }

        if ($item->computePrice === PricelistItem::COMPUTE_PERCENTAGE) {
            return $price->sub(
                $price->mul(Decimal::of($item->percentPrice))->div($hundred, Decimal::MAX_SCALE, RoundingMode::HalfUp),
            );
        }

        $priceLimit = $price;
        $price = $price->sub(
            $price->mul(Decimal::of($item->priceDiscount))->div($hundred, Decimal::MAX_SCALE, RoundingMode::HalfUp),
        );
        $priceRound = Decimal::of($item->priceRound);
        if (! $priceRound->isZero()) {
            $price = $price->roundToStep($priceRound, RoundingMode::HalfUp);
        }
        $price = $price->add(Decimal::of($item->priceSurcharge));

        $minMargin = Decimal::of($item->priceMinMargin);
        if (! $minMargin->isZero()) {
            $floor = $priceLimit->add($minMargin);
            if ($price->lt($floor)) {
                $price = $floor;
            }
        }
        $maxMargin = Decimal::of($item->priceMaxMargin);
        if (! $maxMargin->isZero()) {
            $cap = $priceLimit->add($maxMargin);
            if ($price->gt($cap)) {
                $price = $cap;
            }
        }

        return $price;
    }

    /**
     * §10.2 to §10.4 — filter, rank, sort, first wins.
     *
     * @param  list<PricelistItem>  $items
     */
    private function pick(array $items, PricelistContext $context): ?PricelistItem
    {
        $quantity = Decimal::of($context->quantity);
        $ancestry = \array_values($context->categoryAncestry);

        /** @var list<array{rank: int, item: PricelistItem}> $candidates */
        $candidates = [];
        foreach ($items as $item) {
            if (! $item->active) {
                continue;
            }
            if ($context->date !== null) {
                if ($item->dateStart !== null && $item->dateStart > $context->date) {
                    continue;
                }
                if ($item->dateEnd !== null && $context->date > $item->dateEnd) {
                    continue;
                }
            }
            if (Decimal::of($item->minQuantity)->gt($quantity)) {
                continue;
            }

            switch ($item->appliedOn) {
                case PricelistItem::APPLIED_VARIANT:
                    if ($item->productVariantId !== $context->variantId) {
                        continue 2;
                    }
                    $rank = 0;
                    break;
                case PricelistItem::APPLIED_PRODUCT:
                    if ($item->productId !== $context->productId) {
                        continue 2;
                    }
                    $rank = 1;
                    break;
                case PricelistItem::APPLIED_CATEGORY:
                    $index = $item->posCategoryId === null ? false : \array_search($item->posCategoryId, $ancestry, true);
                    if ($index === false) {
                        continue 2;
                    }
                    $rank = 2 + (int) $index;
                    break;
                default:
                    $rank = self::GLOBAL_RANK;
            }

            $candidates[] = ['rank' => $rank, 'item' => $item];
        }

        if ($candidates === []) {
            return null;
        }

        \usort($candidates, static function (array $a, array $b): int {
            if ($a['rank'] !== $b['rank']) {
                return $a['rank'] <=> $b['rank'];
            }
            $qty = Decimal::of($b['item']->minQuantity)->compare(Decimal::of($a['item']->minQuantity));
            if ($qty !== 0) {
                return $qty;
            }
            if ($a['item']->sequence !== $b['item']->sequence) {
                return $a['item']->sequence <=> $b['item']->sequence;
            }

            return $a['item']->id <=> $b['item']->id;
        });

        return $candidates[0]['item'];
    }
}
