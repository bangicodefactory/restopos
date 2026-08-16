<?php

declare(strict_types=1);

namespace App\Services\Pos;

/**
 * What {@see ApprovalAuthority} made of the manager overrides riding on one push (REG-045).
 *
 * A value object rather than a bare list of ability strings, because the two answers a caller needs
 * are different questions: *may this mutation go through* ({@see allows()}), and *what should the
 * trail say about the attempt* ({@see accepted()} / {@see refusals()}). An approval that fails
 * validation is not simply dropped — a device claiming an override it was never granted is the one
 * event this whole mechanism exists to catch, so it is reported and recorded, not ignored.
 */
final readonly class ApprovalGrant
{
    /**
     * @param  list<string>  $abilities  what a real manager on this config actually authorised
     * @param  list<array<string, mixed>>  $accepted  the approvals behind those abilities, to be recorded
     * @param  list<array<string, mixed>>  $refusals  claims that did not stand up, as warnings
     * @param  array<string, list<string>>  $lines  ability => the line uuids it was granted for.
     *                                              An ability absent from this map was granted
     *                                              without naming a line, and stays order-scoped.
     */
    public function __construct(
        private array $abilities = [],
        private array $accepted = [],
        private array $refusals = [],
        private array $lines = [],
    ) {}

    /**
     * Did a verified manager authorise this ability, for this line? (BAN-515)
     *
     * Two shapes of approval, and the difference is what the client asserted:
     *
     *  - **Line-scoped** — `context.line_uuid` names a line. It authorises that line and no other.
     *    Approving one 90 % discount used to let every line in the same push carry one; three
     *    manual prices stood on a single `line.price_override`. That is wider than the manager
     *    pressed the button for.
     *  - **Order-scoped** — no line named. Authorises the whole push, exactly as before.
     *
     * The fallback is deliberate and is the reason this is not simply "match the line or refuse".
     * A client that has not been updated sends `context: {}` for approvals that are perfectly
     * genuine, and a server inventing a binding the client never asserted would refuse them. The
     * order binding is enforced regardless (`ApprovalAuthority::replayed()`). Narrowing only where
     * the client said something narrower is the honest reading of what was actually approved.
     *
     * @param  string|null  $lineUuid  the line being judged, or null when the ability is not about
     *                                 a line at all (a session close, a cash-movement delete)
     */
    public function allows(string $ability, ?string $lineUuid = null): bool
    {
        if (! in_array($ability, $this->abilities, true)) {
            return false;
        }

        $bound = $this->lines[$ability] ?? [];

        // Granted without naming a line: order-scoped, as it has always been.
        if ($bound === []) {
            return true;
        }

        // Named a line, and the caller is not asking about a line — an order-wide question cannot
        // be answered "yes" by an approval that was deliberately narrowed.
        if ($lineUuid === null) {
            return false;
        }

        return in_array($lineUuid, $bound, true);
    }

    /**
     * Was this line refused *because the approval named a different one*?
     *
     * False when nothing was approved at all — that is the ordinary "nobody authorised this" case
     * and needs no explaining. True only when a manager did approve the ability and bound it
     * elsewhere, which is the answer a cashier staring at a corrected price actually needs.
     *
     * Asked rather than exposing the bindings, so the map stays private to the only object that
     * should be reasoning about it.
     */
    public function deniedByLineBinding(string $ability, string $lineUuid): bool
    {
        if (! in_array($ability, $this->abilities, true)) {
            return false;
        }

        $bound = $this->lines[$ability] ?? [];

        return $bound !== [] && ! in_array($lineUuid, $bound, true);
    }

    /** @return list<array<string, mixed>> */
    public function accepted(): array
    {
        return $this->accepted;
    }

    /** @return list<array<string, mixed>> */
    public function refusals(): array
    {
        return $this->refusals;
    }
}
