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

    /** Did a verified manager authorise this ability on this push? */
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
