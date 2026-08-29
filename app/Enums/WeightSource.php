<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Where the quantity on a weighed `pos_order_lines` row came from (XCT-058, REG-077).
 *
 * Null on every line that is not sold by weight, and that is the useful distinction: a line with a
 * source is a line whose quantity is a *measurement*, and a measurement a human typed is not the
 * same evidence as one a certified instrument produced. In France and Belgium an inspector may ask
 * which it was, and before this column the answer was not recorded anywhere.
 *
 * It is deliberately not a boolean. `manual` is a legitimate, supported fallback — the scale is
 * unplugged, the venue has none — and a nullable boolean would have to encode three states in two
 * values.
 */
enum WeightSource: string
{
    use HasEnumHelpers;

    /** Read from a connected instrument through `shared/scale`. */
    case Scale = 'scale';

    /** Typed on the numpad by the cashier, with the scale off, absent or unavailable. */
    case Manual = 'manual';

    public function label(): string
    {
        return match ($this) {
            self::Scale => 'Read from the scale',
            self::Manual => 'Entered by hand',
        };
    }
}
