<?php

declare(strict_types=1);

namespace App\Support\Http;

use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;
use TypeError;
use ValueError;

/**
 * The one shape every API error takes (spec 03 §3.6.6, BAN-442).
 *
 * The renderer used to map `HttpExceptionInterface` and nothing else, so a `ValueError` out of
 * bcmath or a `QueryException` came back as Laravel's default `{"message": …}` — or, with debug
 * off and the wrong `Accept` header, an HTML page. A till parsing that gets nothing it can act on.
 *
 * **The register already retries a 500.** `classifyHttpError` keys on the HTTP status, not the
 * body, so `status >= 500` has always meant `server_unreachable`, which is retryable. That is the
 * right default and it stays: a till must not discard a sale because the server had a bad minute.
 *
 * What the body adds is the ability to say *this one will never work*. A constraint violation or a
 * malformed number fails identically on every retry, and an entry that retries forever blocks the
 * session close forever — `blocksSessionClose` counts everything not quarantined. Those are named
 * `server_data_error` so the outbox can quarantine them and put them in front of a manager, which
 * is where a payload the server cannot accept belongs.
 *
 * Everything else is `server_error` and keeps retrying. The set below is deliberately tiny: the
 * cost of wrongly calling something permanent is a sale that stops trying, and the cost of wrongly
 * calling it transient is a banner. Only one of those loses money.
 */
final class ErrorEnvelope
{
    /** Retried forever by the outbox. The default, because retrying is the safe mistake. */
    public const ServerError = 'server_error';

    /** Quarantined by the outbox: this payload will fail the same way every time. */
    public const ServerDataError = 'server_data_error';

    /** Codes the client must treat as permanent. Kept here so both sides cite one list. */
    public const Permanent = [self::ServerDataError];

    /** The `error.code` for an HTTP exception — the status *is* the classification. */
    public static function codeForStatus(int $status): string
    {
        return match ($status) {
            401 => 'unauthenticated',
            403 => 'forbidden',
            404 => 'not_found',
            409 => 'conflict',
            410 => 'gone',
            422 => 'unprocessable',
            429 => 'rate_limited',
            default => $status >= 500 ? self::ServerError : 'http_error',
        };
    }

    /**
     * The `error.code` for an unhandled throwable.
     *
     * Deliberately by exception *class*, not by message: messages carry table names, column names
     * and occasionally values, and this string is going over the wire to a device.
     */
    public static function codeForThrowable(Throwable $e): string
    {
        if ($e instanceof HttpExceptionInterface) {
            return self::codeForStatus($e->getStatusCode());
        }

        // A duplicate key is the payload's own doing and will duplicate again on every retry.
        if ($e instanceof UniqueConstraintViolationException) {
            return self::ServerDataError;
        }

        if ($e instanceof QueryException) {
            // SQLSTATE 23xxx is an integrity constraint — the data cannot be stored as sent, no
            // matter how often it is sent. Deadlocks (40001) and lock timeouts are *not* in this
            // class and stay retryable, which is the whole reason for reading the code rather than
            // treating every QueryException the same.
            return str_starts_with((string) ($e->errorInfo[0] ?? ''), '23')
                ? self::ServerDataError
                : self::ServerError;
        }

        // Malformed numbers out of bcmath, and type errors from a payload shape the code did not
        // expect. `bccomp('1e2', …)` has reached production three times (BAN-413, 417, 507).
        if ($e instanceof ValueError || $e instanceof TypeError) {
            return self::ServerDataError;
        }

        return self::ServerError;
    }

    /**
     * What the client is told.
     *
     * The message for a 500 is fixed rather than `$e->getMessage()`: an unhandled throwable's
     * message is written for a developer reading a log, and can name internals. The trace stays in
     * the log, where the correlation id points at it.
     */
    public static function messageFor(Throwable $e, int $status): string
    {
        if ($status < 500) {
            return $e->getMessage() !== '' ? $e->getMessage() : 'Request failed.';
        }

        return 'The server could not complete this request.';
    }
}
