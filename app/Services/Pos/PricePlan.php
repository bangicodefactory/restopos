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
     * @param  array<string, string>  $proposals  line uuid => the unit price the client asked for
     */
    public function __construct(
        private array $prices = [],
        private array $extras = [],
        private array $refusals = [],
        private array $proposals = [],
    ) {}

    /** The server's price for this line, or null when the client's stands. */
    public function priceFor(string $uuid): ?string
    {
        return $this->prices[$uuid] ?? null;
    }

    /**
     * What the client asked to charge for a line the server priced itself — kept only where the two
     * could differ, so the difference between this and {@see priceFor()} is the whole of what the
     * repricing changed.
     *
     * That difference is the only honest bound on a stale-price write-off (BAN-514). The obvious
     * alternative — the client's declared `amount_total_client` — is an unvalidated assertion, and
     * a device that under-declares it has the server forgive whatever balance it likes. This one
     * the device cannot inflate: it is zero exactly when the server changed nothing.
     */
    public function proposedFor(string $uuid): ?string
    {
        return $this->proposals[$uuid] ?? null;
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
