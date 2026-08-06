<?php

declare(strict_types=1);

namespace App\Services\Audit;

use App\Enums\AuditSeverity;
use App\Models\Audit\AuditLog;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosSession;
use Illuminate\Contracts\Auth\Factory as AuthFactory;
use Illuminate\Contracts\Container\Container;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * The one writer of `audit_logs` (BAN-413, spec 01-schema §2.K).
 *
 * Two tables exist for the audit trail and until now the only INSERT into either of them lived in a
 * demo seeder. "Who removed that line", "who opened the drawer at 23:40", "who changed the tax on
 * that product" had no answer at all — which is the half of fraud detection that survives after the
 * fraud, and the half a venue's insurer asks about.
 *
 * ## Three decisions worth knowing about
 *
 * **The write is inside the caller's transaction, not after it.** An audit row that can outlive a
 * rolled-back fact — or vanish while the fact commits — is not evidence, it is a second story. So
 * the log commits with the thing it describes or not at all, and a failure here fails the action.
 * That trade is deliberate: a till that refuses a cash-out because the trail is broken is recoverable;
 * a trail with holes exactly where someone was careful is not.
 *
 * **The actor is resolved, not asserted.** A register request carries a device bearer token and no
 * `web` user; a back-office request carries a user and no device. Callers pass what they know and
 * this fills the rest from the container, so neither surface has to remember the other's shape.
 *
 * **Nothing here is ever sent to a client** (spec §5.4). `AuditLog` is not `PosLoadable` and must
 * not become so — the trail describes the people using the till, to the people who employ them.
 */
final readonly class AuditRecorder
{
    public function __construct(
        private AuthFactory $auth,
        private Container $container,
    ) {}

    /**
     * Record one event against one subject.
     *
     * `$changes` is the `{field: {old, new}}` diff the spec asks for. Pass it already shaped — this
     * does not diff models for you, because the interesting diff is rarely `$model->getDirty()`
     * (that misses a delete entirely, and includes housekeeping columns nobody will ever audit).
     *
     * @param  array<string, array{old: mixed, new: mixed}>  $changes
     */
    public function record(
        string $event,
        Model $subject,
        ?int $companyId = null,
        AuditSeverity $severity = AuditSeverity::Info,
        ?string $message = null,
        array $changes = [],
        PosConfig|int|null $config = null,
        PosSession|int|null $session = null,
        ?int $employeeId = null,
        ?int $userId = null,
        PosDevice|int|null $device = null,
        ?string $uuid = null,
    ): AuditLog {
        $companyId ??= $this->companyOf($subject);

        if ($companyId === null) {
            throw new \InvalidArgumentException(
                "audit_logs.company_id is NOT NULL and event [{$event}] gave no company: pass \$companyId when the subject has no company_id of its own.",
            );
        }

        /** @var AuditLog $log */
        $log = AuditLog::query()->create([
            // Caller-supplied when the event is one a client can replay — the outbox delivers a
            // batch more than once as a matter of routine, and the unique index is what stops a
            // redelivered drawer-open becoming two drawer-opens.
            'uuid' => $uuid ?? (string) Str::uuid(),
            'company_id' => $companyId,
            'pos_config_id' => $this->keyOf($config),
            'pos_session_id' => $this->keyOf($session),
            'subject_type' => $subject->getMorphClass(),
            'subject_id' => $subject->getKey(),
            'event' => $event,
            'severity' => $severity->value,
            'actor_user_id' => $userId ?? $this->currentUserId(),
            'actor_employee_id' => $employeeId,
            'pos_device_id' => $this->keyOf($device),
            'message' => $message === null ? null : mb_substr($message, 0, 500),
            'changes' => $changes === [] ? null : $changes,
            'ip_address' => $this->clientIp(),
            'occurred_at' => now(),
        ]);

        return $log;
    }

    /**
     * Shape a `{field: {old, new}}` diff from two flat maps, keeping only the keys that actually
     * moved.
     *
     * Everything the register pushes arrives as strings, and a resent-but-unchanged payload is the
     * normal case rather than the exception — a draft is re-pushed on every edit and again on
     * payment. So a loose comparison here would fill the trail with rows recording that nothing
     * happened, which is the same as having no trail: the real events stop being findable.
     *
     * @param  array<string, mixed>  $before
     * @param  array<string, mixed>  $after
     * @return array<string, array{old: mixed, new: mixed}>
     */
    public static function diff(array $before, array $after): array
    {
        $changes = [];

        foreach ($after as $field => $new) {
            $old = $before[$field] ?? null;

            if (self::same($old, $new)) {
                continue;
            }

            $changes[$field] = ['old' => $old, 'new' => $new];
        }

        return $changes;
    }

    /**
     * Are these the same value for audit purposes?
     *
     * `'2'` and `'2.000'` are the same quantity, and the client and the database disagree about
     * which one to write it as — the column casts to `decimal:3`, so a value that round-trips comes
     * back with trailing zeros the client never sent. Comparing those as strings would log an edit
     * on every resend.
     */
    private static function same(mixed $old, mixed $new): bool
    {
        if (self::bcSafe($old) && self::bcSafe($new)) {
            return bccomp((string) $old, (string) $new, 6) === 0;
        }

        if (is_bool($old) || is_bool($new)) {
            return (bool) $old === (bool) $new;
        }

        return (string) ($old ?? '') === (string) ($new ?? '');
    }

    /**
     * Is this something `bccomp` will actually accept?
     *
     * `is_numeric()` is the obvious test and it is wrong here: it accepts `'1e2'` and `' 3'`, and
     * bcmath throws a `ValueError` on both. Thrown from inside the ingest transaction that means a
     * client sending a quantity in exponent notation does not get a bad-value warning — it gets its
     * order **rejected**, and the audit trail is what rejected it. (`TrimStrings` happens to cover
     * the whitespace case; nothing covers the exponent one.)
     *
     * Anything that fails here falls through to the string comparison below, which is the correct
     * outcome anyway: a value bcmath cannot read is not a number we can meaningfully diff.
     */
    public static function bcSafe(mixed $value): bool
    {
        return (is_string($value) || is_int($value) || is_float($value))
            && preg_match('/^[+-]?(\d+(\.\d*)?|\.\d+)$/', (string) $value) === 1;
    }

    private function companyOf(Model $subject): ?int
    {
        /** @var mixed $companyId */
        $companyId = $subject->getAttribute('company_id');

        return $companyId === null ? null : (int) $companyId;
    }

    private function keyOf(Model|int|null $value): ?int
    {
        return match (true) {
            $value === null => null,
            $value instanceof Model => (int) $value->getKey(),
            default => $value,
        };
    }

    /**
     * The signed-in back-office user, if there is one.
     *
     * Guarded against a session-less context: console commands, queued jobs and device requests all
     * reach this, and `Auth::id()` on a stateful guard boots the session driver to answer.
     */
    private function currentUserId(): ?int
    {
        $user = $this->auth->guard('web')->user();

        return $user === null ? null : (int) $user->getAuthIdentifier();
    }

    /**
     * The caller's IP, or null outside an HTTP request — a queue worker has no client.
     *
     * Resolved per call rather than injected. Injecting `Request` into a constructor binds whichever
     * request happened to be in flight when this service was first built; today nothing keeps it
     * that long, but under a persistent worker (Octane) a service resolved once would go on stamping
     * the first request's IP onto every later one. An audit trail that attributes an action to the
     * wrong address is worse than one that admits it does not know.
     */
    private function clientIp(): ?string
    {
        if (! $this->container->bound('request')) {
            return null;
        }

        /** @var Request $request */
        $request = $this->container->make('request');

        $ip = $request->ip();

        return $ip === null ? null : mb_substr($ip, 0, 45);
    }
}
