<?php

declare(strict_types=1);

namespace App\Exceptions\Pos;

use DomainException;

/**
 * The register cannot open a session because its configuration is incomplete (REG-002).
 *
 * Carries the whole list rather than the first failure: a manager sent back to the back office
 * deserves to fix everything in one trip, not to be told about the next missing piece each time
 * they walk back to the till.
 */
final class RegisterNotReady extends DomainException
{
    /** @param  list<array{code: string, message: string}>  $problems */
    public function __construct(public readonly array $problems)
    {
        parent::__construct(
            'This register is not configured to open a session: '
            .implode(' ', array_column($problems, 'message')),
        );
    }
}
