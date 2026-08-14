<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\ErrorEnvelope;

use App\Support\Http\ErrorEnvelope;
use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-442 — every API failure in one shape.
 *
 * The renderer mapped `HttpExceptionInterface` and nothing else, so a `ValueError` out of bcmath or
 * a `QueryException` came back as Laravel's `{"message": …}` — or, with debug off and the wrong
 * `Accept` header, an HTML page. A till can act on neither.
 *
 * Worth being precise about what this changes, because the obvious reading is wrong: **the register
 * already retried 500s.** `classifyHttpError` keys on the status, not the body, so `>= 500` has
 * always meant `server_unreachable`, which is retryable — and that stays the default, because a
 * till must not discard a sale over a bad minute on the server.
 *
 * What the body adds is the server's ability to say *this one will never work*. A constraint
 * violation fails identically on every retry, and an entry retrying forever blocks the session
 * close forever, since `blocksSessionClose` counts everything not quarantined.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

/**
 * An API route that fails the way a real defect would.
 *
 * The renderer is what is under test, not any one service — it is global, and the point is that
 * *whatever* throws on an `api/*` route comes back in the envelope. A route is the smallest way to
 * say that; `OrderSyncService` is `final` and mocking it would test the mock anyway.
 */
function boom(\Throwable $e): TestResponse
{
    Route::post('api/_test/boom', function () use ($e): never {
        throw $e;
    });

    return test()->postJson('/api/_test/boom');
}

describe('an unhandled throwable still comes back as the envelope', function (): void {
    it('wraps a query exception', function (): void {
        $response = boom(new QueryException('sqlite', 'insert into x', [], new \Exception('no such column')))
            ->assertStatus(500);

        expect($response->json('error.code'))->toBe(ErrorEnvelope::ServerError)
            ->and($response->json('error.message'))->toBeString();
    });

    it('wraps a ValueError, which is how bcmath fails', function (): void {
        // `bccomp('1e2', …)` has reached production three times (BAN-413, BAN-417, BAN-507).
        boom(new \ValueError('bccomp(): Argument #1 must be a well-formed numeric string'))
            ->assertStatus(500)
            ->assertJsonPath('error.code', ErrorEnvelope::ServerDataError);
    });

    it('never puts the exception message on the wire', function (): void {
        // An unhandled throwable's message is written for a developer reading a log, and names
        // tables, columns and occasionally values. The trace stays in the log.
        $response = boom(new \RuntimeException('SQLSTATE[42S22]: column customers.secret_column not found'))
            ->assertStatus(500);

        expect($response->json('error.message'))->not->toContain('secret_column')
            ->and($response->json('error.message'))->not->toContain('SQLSTATE');
    });

    it('still answers an ordinary HTTP exception the way it always did', function (): void {
        boom(new NotFoundHttpException('No such thing.'))
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'not_found')
            ->assertJsonPath('error.message', 'No such thing.');
    });

    it('does not turn an unauthenticated request into a server error', function (): void {
        // Laravel maps `AuthenticationException` to 401 *after* the render callback runs, so taking
        // it over here made every unauthenticated API call a 500. The accounting-export auth test
        // caught it on the first full run — this pins it where the reason is written down.
        // A back-office route, deliberately: `api/pos/*` is behind the device middleware, which
        // throws an `HttpException` and would pass either way. Laravel's `auth` middleware throws
        // `AuthenticationException`, which is the one that broke.
        test()->getJson(route('accounting-exports.download', ['export' => (string) Str::uuid()]))
            ->assertStatus(401);
    });

    it('logs a 500 once, not twice (review of #54)', function (): void {
        // The handler reports before it renders, so a `report($e)` inside the render callback
        // logged every 500 twice — which inflates error counts and any alerting keyed on them.
        $records = 0;
        Log::listen(function () use (&$records): void {
            $records++;
        });

        boom(new \RuntimeException('boom'))->assertStatus(500);

        expect($records)->toBe(1);
    });

    it('keeps an authored HTTP message even at 500 (review of #54)', function (): void {
        // The rule is about *unhandled* throwables, whose messages are written for a developer
        // reading a log. An `HttpException` message was written for the caller.
        boom(new HttpException(503, 'Down for maintenance until 06:00.'))
            ->assertStatus(503)
            ->assertJsonPath('error.message', 'Down for maintenance until 06:00.');
    });

    it('leaves validation errors alone, because their body carries per-field detail', function (): void {
        // 422 is classified from the status; wrapping it would throw away the `errors` map the
        // back office renders against each input.
        test()->withHeaders($this->fx->headers())
            ->postJson('/api/pos/sessions', ['opening_float' => 'not a number'])
            ->assertStatus(422)
            ->assertJsonStructure(['message', 'errors']);
    });
});

describe('which failures are permanent', function (): void {
    it('calls an integrity violation permanent, because the same payload violates it again', function (): void {
        $e = new QueryException('sqlite', 'insert', [], new \Exception('constraint failed'));
        $e->errorInfo = ['23000', 19, 'UNIQUE constraint failed'];

        expect(ErrorEnvelope::codeForThrowable($e))->toBe(ErrorEnvelope::ServerDataError);
    });

    it('calls a deadlock transient, which is the reason for reading the SQLSTATE at all', function (): void {
        // Treating every QueryException as permanent would quarantine sales over lock contention —
        // the one failure that is *certain* to succeed on retry.
        $e = new QueryException('sqlite', 'update', [], new \Exception('deadlock detected'));
        $e->errorInfo = ['40001', 1213, 'Deadlock found'];

        expect(ErrorEnvelope::codeForThrowable($e))->toBe(ErrorEnvelope::ServerError);
    });

    it('calls a duplicate key permanent', function (): void {
        $e = new UniqueConstraintViolationException('sqlite', 'insert', [], new \Exception('duplicate'));

        expect(ErrorEnvelope::codeForThrowable($e))->toBe(ErrorEnvelope::ServerDataError);
    });

    it('calls anything it does not recognise transient', function (): void {
        // The safe mistake. Wrongly permanent stops a sale retrying; wrongly transient shows a
        // banner. Only one of those loses money.
        expect(ErrorEnvelope::codeForThrowable(new \RuntimeException('who knows')))->toBe(ErrorEnvelope::ServerError);
    });

    it('publishes the permanent set for the client to agree with', function (): void {
        expect(ErrorEnvelope::Permanent)->toBe([ErrorEnvelope::ServerDataError]);
    });
});

describe('the sync path still behaves', function (): void {
    it('does not wrap a per-order rejection, which is not a request failure', function (): void {
        // A rejected order is a 200 with a per-record result. Turning it into a 500 would make the
        // whole batch retry instead of the one record surfacing to a manager.
        $response = test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
            $this->fx->orderCommand((string) Str::uuid(), [[
                'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => 999999,
                'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
            ]]),
        ]])->assertOk();

        expect($response->json('results.0.lines.0.status'))->toBe('rejected');
    });
});
