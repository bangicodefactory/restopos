<?php

declare(strict_types=1);

namespace App\Rules;

use App\Models\Identity\Employee;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * What a cashier's PIN may be (BOF-121, BAN-446).
 *
 * The rule was `min:4|max:12` and nothing else, so `0000` and `1234` were both acceptable — on the
 * credential that authorises a void, a price override and an over-variance session close.
 *
 * **A shared PIN is not an identity problem.** `verifyPin(deps, employeeId, pin)` takes the employee
 * first and verifies second, so two people with the same PIN are never confused for one another. It
 * is an *accountability* problem, which in a till is the same thing by a different route: the audit
 * trail's whole purpose is answering "who did this", and two people who can each pass as the other
 * makes every answer it gives unreliable. So a PIN already in use is refused.
 *
 * Only digits, because the till's PIN pad emits digits and nothing else — a letter here would be a
 * PIN that can be set in the back office and never typed at the register.
 */
final class StaffPin implements ValidationRule
{
    public function __construct(
        private readonly int $companyId,
        private readonly ?int $ignoreEmployeeId = null,
    ) {}

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        $pin = (string) $value;

        if (preg_match('/^\d{4,12}$/', $pin) !== 1) {
            $fail('A PIN is between 4 and 12 digits, and digits only — the till\'s keypad has nothing else on it.');

            return;
        }

        if (count(array_unique(str_split($pin))) === 1) {
            $fail('That PIN is the same digit repeated. Anyone watching the keypad once has it.');

            return;
        }

        if ($this->isRun($pin)) {
            $fail('That PIN is a straight run of digits. Choose something that is not the first thing tried.');

            return;
        }

        if ($this->isTaken($pin)) {
            // Deliberately does not say *whose*. Naming the colleague would turn a validation message
            // into a way of learning another person's PIN by elimination.
            $fail('Another member of staff already uses that PIN. Two people who can each sign as the'
                .' other makes the audit trail unable to answer who did what.');
        }
    }

    /** `1234` and `4321` alike — a run in either direction is equally guessable. */
    private function isRun(string $pin): bool
    {
        $digits = array_map(intval(...), str_split($pin));
        $up = true;
        $down = true;

        for ($i = 1, $n = count($digits); $i < $n; $i++) {
            $step = $digits[$i] - $digits[$i - 1];

            if ($step !== 1) {
                $up = false;
            }

            if ($step !== -1) {
                $down = false;
            }
        }

        return $up || $down;
    }

    private function isTaken(string $pin): bool
    {
        $query = Employee::query()
            ->where('company_id', $this->companyId)
            ->where('pin_hash', hash('sha256', $pin));

        if ($this->ignoreEmployeeId !== null) {
            $query->whereKeyNot($this->ignoreEmployeeId);
        }

        return $query->exists();
    }
}
