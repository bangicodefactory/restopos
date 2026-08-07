<?php

declare(strict_types=1);

namespace App\Services\Pos;

/**
 * What {@see LinePriceAuthority} decided for one push, read by the line writers.
 *
 * A value object rather than three loose arrays so the "no opinion" case has to be handled: a
 * missing key means *the client's number stands*, and that is a different statement from "the
 * server priced this at zero". Returning `null` makes the caller say which one it meant.
 */
final readonly class PricePlan
{
    public const Server = 'server';

    public const Client = 'client';

    /**
     * @param  array<string, string>  $prices  line uuid => the server's unit price
     * @param  array<string, string>  $extras  line uuid => the server's attribute extra
     * @param  list<array<string, mixed>>  $refusals  overrides the pushing employee could not make
     */
    public function __construct(
        private array $prices = [],
        private array $extras = [],
        private array $refusals = [],
    ) {}

    /** The server's price for this line, or null when the client's stands. */
    public function priceFor(string $uuid): ?string
    {
        return $this->prices[$uuid] ?? null;
    }

    /** The server's attribute extra for this line, or null when the client's stands. */
    public function extraFor(string $uuid): ?string
    {
        return $this->extras[$uuid] ?? null;
    }

    /**
     * Manual prices that were corrected rather than accepted.
     *
     * Surfaced as order-level warnings: the sale goes through at the catalogue price, and the
     * attempt is reported instead of being silently honoured or silently dropped.
     *
     * @return list<array<string, mixed>>
     */
    public function refusals(): array
    {
        return $this->refusals;
    }
}
