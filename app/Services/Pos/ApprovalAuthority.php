<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Models\Audit\AuditLog;
use App\Models\Identity\Employee;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Services\Identity\EmployeeAuthService;
use Illuminate\Contracts\Config\Repository as ConfigRepository;

/**
 * Decide whether the manager overrides a push claims were really granted (REG-045, BAN-430).
 *
 * ## What was wrong
 *
 * The client half of this has worked for a long time: `approval.ts` prompts for a PIN, checks it,
 * and records an `ApprovalRow`. BAN-413 then started syncing those rows and writing them to the
 * audit trail. What nobody did was *check them*. `recordApprovals()` took the claim at face value —
 * the ability was a free string and the manager id was whatever the device said — so the trail
 * recorded, in good faith, exactly what a patched till told it to. Probed against master:
 *
 * - an approval for `line.discount.above_limit` signed by the **cashier**, who does not hold that
 *   ability, was recorded as a manager override;
 * - an approval for `nuclear.launch`, an ability that does not exist, was recorded too.
 *
 * A trail that records forgeries beside genuine approvals is worse than no trail: it is the report
 * a manager reaches for when money is missing, and it will agree with the person who took it.
 *
 * ## The three things checked
 *
 * An approval stands only when the ability is one this system actually defines, the employee named
 * is one of *this config's* employees, and that employee genuinely holds the ability. Anything else
 * is refused — reported to the device and written to the trail as a refusal, because an override
 * that was claimed and rejected is more interesting than one that was never claimed.
 *
 * The PIN itself is deliberately not re-checked here. The device verified it (online against the
 * server, offline against a cached hash, and `verified` carries which), and the PIN does not travel
 * with the order. What this closes is the gap that mattered: a claim naming somebody who could not
 * have granted it.
 */
final readonly class ApprovalAuthority
{
    public function __construct(
        private EmployeeAuthService $employees,
        private ConfigRepository $config,
    ) {}

    /**
     * @param  array<int, mixed>  $approvals  the `approvals` array as the device sent it
     */
    public function validate(PosConfig $config, array $approvals, Order $order): ApprovalGrant
    {
        if ($approvals === []) {
            return new ApprovalGrant;
        }

        $known = $this->catalogue($config);
        // Resolved once: a push may carry several approvals, and each would otherwise re-query.
        $employees = $this->employees->candidates($config)->keyBy(static fn (Employee $e): int => (int) $e->getKey());

        $abilities = [];
        $accepted = [];
        $refusals = [];
        // ability => the lines it was granted for (BAN-515). An ability that appears here with an
        // empty list was granted without naming a line and stays order-scoped.
        $lines = [];

        foreach ($approvals as $approval) {
            $approval = (array) $approval;
            $uuid = (string) ($approval['uuid'] ?? '');
            $ability = (string) ($approval['ability'] ?? '');
            $employeeId = isset($approval['manager_employee_id']) ? (int) $approval['manager_employee_id'] : null;

            // Not a claim at all — nothing to validate and nothing to record. `recordApprovals()`
            // has always skipped these.
            if ($uuid === '' || $ability === '') {
                continue;
            }

            $reason = $this->reject($known, $employees->get($employeeId), $config, $ability, $employeeId)
                ?? $this->replayed($uuid, $order);

            if ($reason !== null) {
                $refusals[] = [
                    'code' => 'approval_refused',
                    'reason' => $reason,
                    'uuid' => $uuid,
                    'ability' => $ability,
                    'manager_employee_id' => $employeeId,
                ];

                continue;
            }

            $abilities[] = $ability;
            $accepted[] = $approval;

            $line = $this->lineContext($approval);

            if ($line === null) {
                // Order-scoped. Recorded as such so a later line-scoped approval for the same
                // ability cannot narrow what this one already granted — two approvals mean the
                // manager pressed the button twice, and the wider one stands.
                $lines[$ability] = [];

                continue;
            }

            // Only narrow an ability that has not already been granted order-wide.
            if (! array_key_exists($ability, $lines) || $lines[$ability] !== []) {
                $lines[$ability][] = $line;
            }
        }

        return new ApprovalGrant(
            array_values(array_unique($abilities)),
            $accepted,
            $refusals,
            array_map(static fn (array $l): array => array_values(array_unique($l)), $lines),
        );
    }

    /**
     * The line an approval names, or null when it names none.
     *
     * The client writes `context: {"line_uuid": "…"}` when a manager approves an override on one
     * line. Anything else — an absent context, a context about something other than a line — reads
     * as order-scoped, which is what every client before BAN-515 sent.
     *
     * @param  array<string, mixed>  $approval
     */
    private function lineContext(array $approval): ?string
    {
        $context = $approval['context'] ?? null;

        if (! is_array($context)) {
            return null;
        }

        $line = $context['line_uuid'] ?? null;

        return is_string($line) && $line !== '' ? $line : null;
    }

    /**
     * Why this claim does not stand, or null if it does.
     *
     * Named reasons rather than a bare false: "the manager who signed this does not have that
     * permission" and "there is no such permission" are different incidents, and the second is
     * a device sending something no build of this client would ever produce.
     */
    private function reject(
        array $known,
        ?Employee $employee,
        PosConfig $config,
        string $ability,
        ?int $employeeId,
    ): ?string {
        if (! in_array($ability, $known, true)) {
            return 'unknown_ability';
        }

        if ($employeeId === null) {
            return 'no_approver';
        }

        // `candidates()` is already scoped to this config's company, so an id belonging to another
        // venue simply is not here — which is the answer we want, and the same one an id that was
        // invented outright gets.
        if (! $employee instanceof Employee) {
            return 'unknown_approver';
        }

        if (! $this->employees->can($employee, $config, $ability)) {
            return 'approver_lacks_ability';
        }

        return null;
    }

    /**
     * Has this approval already been spent on a different order? (BAN-430)
     *
     * A manager approves *one* thing. `approval.ts` knows that — it stores each row against an
     * `order_uuid` and `persistence.ts` only ever attaches an order's own. Nothing made the server
     * agree, so an approval was a bearer token: get one 90% discount signed off, keep the row, and
     * replay it on every order for the rest of the shift. Probed at five orders, all five took the
     * discount — and because `recordApprovals()` skips a uuid already on the trail, the audit log
     * showed the manager approving *once*. The dedupe that stops one override being counted forty
     * times was hiding thirty-nine.
     *
     * The trail is the record of what was spent, so it is also what says whether it was: the row
     * carries the approval uuid and the order it was granted for. Re-sending the same approval with
     * its *own* order is the ordinary case — the register pushes an order on every edit — and stays
     * allowed.
     */
    private function replayed(string $uuid, Order $order): ?string
    {
        $spentOn = AuditLog::query()
            ->where('uuid', $uuid)
            ->where('subject_type', $order->getMorphClass())
            ->value('subject_id');

        if ($spentOn === null || (int) $spentOn === (int) $order->getKey()) {
            return null;
        }

        return 'approval_replayed';
    }

    /**
     * Every ability this system defines, across all roles.
     *
     * The union rather than any one role's list: an approval is a *manager* granting something to a
     * cashier, so the ability being claimed is by definition not one the pusher holds. What matters
     * is only that it is a real permission, and the per-employee check below decides the rest.
     *
     * @return list<string>
     */
    private function catalogue(PosConfig $config): array
    {
        // Both sources, not one or the other. `abilitiesFor()` falls back per *role*, so a config
        // that overrides only the cashier still grants managers the defaults — reading the override
        // alone would make every manager-only ability look invented.
        $sources = [(array) $this->config->get('pos.role_abilities', [])];

        if (is_array($config->getAttribute('role_abilities'))) {
            $sources[] = $config->getAttribute('role_abilities');
        }

        $all = [];

        foreach ($sources as $roles) {
            foreach ($roles as $abilities) {
                foreach ((array) $abilities as $ability) {
                    $all[] = (string) $ability;
                }
            }
        }

        return array_values(array_unique($all));
    }
}
