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
     */
    public function __construct(
        private array $abilities = [],
        private array $accepted = [],
        private array $refusals = [],
    ) {}

    /**
     * Did a verified manager authorise this ability on this push?
     *
     * **Order-scoped, not line-scoped, and that is a decision.** `ApprovalRow` carries an
     * `order_uuid` and an always-empty `context: {}`, so the client records *which order* an
     * approval was granted for and never which line. One approval therefore unlocks the ability for
     * every line in the push: three manual prices under a single `line.price_override` all stand.
     *
     * That is wider than the manager pressed the button for, and narrowing it needs the client to
     * populate `context` with the line — tracked separately rather than guessed at here, because a
     * server that invented a line binding the client never sent would refuse approvals that are
     * perfectly genuine. The order binding is enforced (see `ApprovalAuthority::replayed()`), which
     * is the whole of what the client actually asserts.
     */
    public function allows(string $ability): bool
    {
        return in_array($ability, $this->abilities, true);
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
