<?php

declare(strict_types=1);

namespace App\Exceptions\Pos;

use DomainException;

/**
 * Thrown when an order is overpaid but the config has no cash-type payment method to give the
 * change back from (REG-204). The ingest turns this into a defined `change_without_cash` rejection
 * rather than a generic failure.
 */
final class ChangeWithoutCashException extends DomainException
{
    public function __construct(string $message = 'Change is due but no cash payment method is configured.')
    {
        parent::__construct($message);
    }
}
