<?php

declare(strict_types=1);

namespace App\Support\Validation;

/**
 * Validation rules for a money amount that will be handed to bcmath.
 *
 * `numeric` is not enough and never was: `is_numeric('1e2')` is true, and `bccomp('1e2', …)` throws
 * a ValueError. That is not a hypothetical — it has now been the same defect three times, on the
 * audit trail (BAN-413), on the opening float (BAN-417), and on the closing count and denomination
 * values (BAN-507), each time reaching production code as a 500 on a money path. `decimal` rejects
 * exponent notation, which is why it is the rule here.
 *
 * This exists to be *found*. Three separate fixes for one trap means the next money field would have
 * carried it too; naming the concept gives the next author something to copy.
 */
final class Amount
{
    /** Every money column in the schema is `decimal(16, 4)`. */
    public const Scale = 4;

    /**
     * A well-formed amount of any sign.
     *
     * Signed on purpose where money can genuinely go both ways — a payment method whose refunds
     * outrun its takings expects a negative total, which happens the moment a customer returns
     * tomorrow with yesterday's receipt.
     *
     * @return list<string>
     */
    public static function signed(): array
    {
        return ['string', 'decimal:0,'.self::Scale];
    }

    /**
     * A well-formed amount that cannot be negative.
     *
     * For quantities of physical cash: a drawer holds no negative notes, and a banknote has no
     * negative face value. Anything owed *out* of a drawer is a cash movement, not a balance.
     *
     * @return list<string>
     */
    public static function unsigned(): array
    {
        return [...self::signed(), 'min:0'];
    }
}
