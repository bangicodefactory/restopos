<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice\Concerns;

use App\Services\Audit\AuditRecorder;
use BackedEnum;
use Illuminate\Database\Eloquent\Model;

/**
 * Which submitted fields a save would actually *change*.
 *
 * Presence is not change, and on this back office the difference is the whole usability of a guard.
 * Every editor is one Inertia `useForm`, so a save posts the entire form whether or not the operator
 * touched a control. A guard written against "which keys arrived" therefore fires on every save:
 *
 *  - a tax could not be renamed while a table had an open tab, refused by a message saying the name
 *    could still be changed (BAN-396, review of #84)
 *  - a payment method could not be reordered mid-session, refused by a message saying only its order
 *    could be changed (BAN-424, review of #85)
 *
 * Both messages were true of the intended rule and false of the code. Both tests passed, because both
 * posted a hand-written two-key payload no browser ever sends.
 *
 * Comparison is per type on purpose. A browser sends `'21'` for a stored `'21.0000'`, `1` for a
 * stored `true`, `''` for a stored null, and a plain string against a cast enum; every one of those
 * reads as an edit under `!==`, and `==` is worse — it makes `'0'` equal to `''` and `'abc'` equal
 * to `0`.
 *
 * The numeric test is `AuditRecorder::bcSafe`, not `is_numeric`, and that is not style. `is_numeric`
 * accepts `'1e2'`, which `bccomp` rejects with a `ValueError` — so a rate typed in exponent notation
 * into a `type=number` box turned a refusal into a 500. `AuditRecorder` had already learned this and
 * written down why; sharing the helper is what keeps the lesson in one place rather than two.
 */
trait DetectsRealChanges
{
    /**
     * @param  list<string>  $keys  the attributes to compare; others in `$data` are ignored
     * @param  array<string, mixed>  $data
     * @return list<string> the subset of `$keys` the payload would move
     */
    protected function realChanges(Model $model, array $data, array $keys): array
    {
        $changed = [];

        foreach ($keys as $key) {
            if (! array_key_exists($key, $data)) {
                continue;
            }

            if (! $this->sameValue($model->getAttribute($key), $data[$key])) {
                $changed[] = $key;
            }
        }

        return $changed;
    }

    /** Is the submitted value the one already stored, allowing for how a form serialises things? */
    private function sameValue(mixed $current, mixed $submitted): bool
    {
        if ($current instanceof BackedEnum) {
            $current = $current->value;
        }

        if (is_bool($current) || is_bool($submitted)) {
            return (bool) $current === (bool) $submitted;
        }

        if ($current === null || $submitted === null) {
            // `''` from an emptied text input is the same as a stored null; `'x'` is not.
            return ($current ?? '') === '' && ($submitted ?? '') === '';
        }

        if (AuditRecorder::bcSafe($current) && AuditRecorder::bcSafe($submitted)) {
            // Decimal-safe: `'21'` and `'21.0000'` are the same rate, and neither is a float.
            return bccomp((string) $current, (string) $submitted, 6) === 0;
        }

        if (is_array($current) || is_array($submitted)) {
            return $current === $submitted;
        }

        return (string) $current === (string) $submitted;
    }
}
