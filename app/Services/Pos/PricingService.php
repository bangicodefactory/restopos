<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Models\Pos\PosConfig;
use App\Support\Pricing\Dto\Pricelist as PricelistDto;
use App\Support\Pricing\Dto\PricelistContext;
use App\Support\Pricing\Dto\PricelistItem as PricelistItemDto;
use App\Support\Pricing\PricelistResolver;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;

/**
 * Server-side pricelist resolution (spec 03 §4.4).
 *
 * The register resolves prices client-side so it works offline; the server
 * re-resolves on ingest. For a **trusted** register a divergence is a warning
 * (a manual price override is legitimate). For **self-order** — an untrusted
 * client — the server's number is simply used, which is what stops a tampered
 * cart payload from setting its own prices.
 *
 * All arithmetic lives in `App\Support\Pricing\PricelistResolver`; this class
 * only loads rows and builds the resolver's value objects.
 */
final class PricingService
{
    /** @var array<int, PricelistResolver> keyed by company */
    private array $resolvers = [];

    /** @var array<int, list<int>> category id => ancestry, nearest first */
    private array $ancestry = [];

    /**
     * @var array<int, object|null> variant id => its pricing row
     *
     * Memoised for the same reason the resolvers and the ancestry above are, and it matters more
     * than either: since BAN-502 the ingest prices every line of a push through here, and a
     * restaurant tab repeats its variants constantly — four of the same beer are four lines. Two
     * queries per line became two per *distinct* variant per request.
     */
    private array $variants = [];

    public function __construct(private readonly ConnectionInterface $connection) {}

    /**
     * The unit price for one variant under one pricelist, before tax and before
     * line discount.
     */
    public function priceFor(PosConfig $config, int $variantId, ?int $pricelistId, string $quantity = '1'): string
    {
        $variant = $this->variant($variantId);

        if ($variant === null) {
            return '0';
        }

        $listPrice = (string) ($variant->variant_price ?? $variant->product_price);

        if ($pricelistId === null) {
            return $listPrice;
        }

        $context = new PricelistContext(
            listPrice: $listPrice,
            quantity: $quantity,
            variantId: $variantId,
            productId: (int) $variant->product_id,
            categoryId: $variant->pos_category_id === null ? null : (int) $variant->pos_category_id,
            categoryAncestry: $variant->pos_category_id === null ? [] : $this->ancestryFor((int) $variant->pos_category_id),
            standardPrice: (string) ($variant->variant_cost ?: $variant->product_cost),
            priceExtra: (string) $variant->price_extra,
            // Without this, `PricelistResolver` skips its window check entirely (it is guarded on a
            // non-null date) and **every dated rule applied forever on the server**: last winter's
            // happy hour still discounting in August. The register passes `date: nowIso()`, so the
            // two disagreed — and on sync the server price wins (`OrderSyncService`), which means the
            // till charged full price, printed full price, and the order was recorded discounted.
            date: self::moment(now()),
        );

        return $this->resolver($config)->resolve($pricelistId, $context);
    }

    /**
     * The pricelist that applies to an order (spec §4.4 step 1):
     * order → preset → customer → config.
     */
    public function resolvePricelistId(PosConfig $config, ?int $orderPricelistId, ?int $presetId, ?int $customerId): ?int
    {
        if ($orderPricelistId !== null) {
            return $orderPricelistId;
        }

        if ($presetId !== null) {
            $id = $this->connection->table('pos_presets')->where('id', $presetId)->value('pricelist_id');

            if ($id !== null) {
                return (int) $id;
            }
        }

        if ($customerId !== null && $config->use_pricelists) {
            $id = $this->connection->table('customers')->where('id', $customerId)->value('pricelist_id');

            if ($id !== null) {
                return (int) $id;
            }
        }

        return $config->pricelist_id === null ? null : (int) $config->pricelist_id;
    }

    /**
     * One comparable spelling of an instant.
     *
     * The window comparison in `PricelistResolver` is a **string** comparison, and the two ends
     * arrived spelled differently: the rows come off the query builder as `2026-08-28 18:00:00`
     * while a Carbon instance stringifies with a `T`. `' ' < 'T'`, so a rule opening at 18:00 today
     * would have compared as already open at 04:00 — right for a different year, wrong within a day,
     * which is exactly the granularity happy hour uses.
     */
    private static function moment(mixed $value): ?string
    {
        return $value === null ? null : Carbon::parse((string) $value)->format('Y-m-d H:i:s');
    }

    private function resolver(PosConfig $config): PricelistResolver
    {
        $companyId = (int) $config->company_id;

        if (isset($this->resolvers[$companyId])) {
            return $this->resolvers[$companyId];
        }

        $items = [];

        foreach ($this->connection->table('pricelist_items')->where('company_id', $companyId)->where('active', true)->orderBy('sequence')->get() as $row) {
            $items[(int) $row->pricelist_id][] = new PricelistItemDto(
                id: (int) $row->id,
                appliedOn: (string) $row->applied_on,
                productVariantId: $row->product_variant_id === null ? null : (int) $row->product_variant_id,
                productId: $row->product_id === null ? null : (int) $row->product_id,
                posCategoryId: $row->pos_category_id === null ? null : (int) $row->pos_category_id,
                minQuantity: (string) $row->min_quantity,
                dateStart: self::moment($row->date_start),
                dateEnd: self::moment($row->date_end),
                computePrice: (string) $row->compute_price,
                fixedPrice: (string) $row->fixed_price,
                percentPrice: (string) $row->percent_price,
                base: (string) $row->base,
                basePricelistId: $row->base_pricelist_id === null ? null : (int) $row->base_pricelist_id,
                priceDiscount: (string) $row->price_discount,
                priceSurcharge: (string) $row->price_surcharge,
                priceRound: (string) $row->price_round,
                priceMinMargin: (string) $row->price_min_margin,
                priceMaxMargin: (string) $row->price_max_margin,
                sequence: (int) $row->sequence,
            );
        }

        $pricelists = [];

        foreach ($this->connection->table('pricelists')->where('company_id', $companyId)->get() as $row) {
            $pricelists[] = new PricelistDto(
                id: (int) $row->id,
                items: $items[(int) $row->id] ?? [],
            );
        }

        return $this->resolvers[$companyId] = new PricelistResolver($pricelists);
    }

    /** @return list<int> nearest ancestor first */
    private function ancestryFor(int $categoryId): array
    {
        if (isset($this->ancestry[$categoryId])) {
            return $this->ancestry[$categoryId];
        }

        $chain = [];
        $cursor = $categoryId;
        $guard = 0;

        while ($cursor !== 0 && $guard++ < 10) {
            $chain[] = $cursor;
            $parent = $this->connection->table('pos_categories')->where('id', $cursor)->value('parent_id');
            $cursor = $parent === null ? 0 : (int) $parent;
        }

        return $this->ancestry[$categoryId] = $chain;
    }

    private function variant(int $variantId): ?object
    {
        if (array_key_exists($variantId, $this->variants)) {
            return $this->variants[$variantId];
        }

        $row = $this->connection->table('product_variants')
            ->join('products', 'products.id', '=', 'product_variants.product_id')
            ->where('product_variants.id', $variantId)
            ->select([
                'product_variants.product_id',
                'product_variants.price_extra',
                'product_variants.list_price as variant_price',
                'product_variants.standard_price as variant_cost',
                'products.list_price as product_price',
                'products.standard_price as product_cost',
            ])
            ->first();

        if ($row === null) {
            return $this->variants[$variantId] = null;
        }

        $row->pos_category_id = $this->connection->table('pos_category_product')
            ->where('product_id', $row->product_id)
            ->orderBy('sequence')
            ->value('pos_category_id');

        return $this->variants[$variantId] = $row;
    }
}
