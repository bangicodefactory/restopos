<?php

declare(strict_types=1);

namespace Tests\Feature\Kitchen\PrintJobLease;

use App\Enums\PrintJobState;
use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/*
|--------------------------------------------------------------------------
| The print-job lease (KDS-060, XCT-054, BAN-411)
|--------------------------------------------------------------------------
|
| `index` used to hand every `queued` row to whoever asked and write nothing
| back, and `PrintJobState::Printing` had no writer anywhere in the codebase —
| the enum was already shaped for a lease nobody had written. Two agents on one
| config would print every ticket twice; the only reason no venue has seen that
| is that this queue has never had a consumer at all.
|
| A lease, not a flag: an agent killed mid-job cannot release anything, so the
| claim must expire by itself or the ticket is lost until someone notices a
| table never got its food.
*/

beforeEach(function (): void {
    $this->fx = PosFixtures::make();
});

/** A second paired device on the same config — the second agent. */
function secondAgent(PosFixtures $fx): array
{
    $device = PosDevice::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $fx->config->getKey(),
        'device_identifier' => 2,
        'name' => 'Agent 2',
        'device_type' => $fx->device->device_type,
        'active' => true,
    ]);

    $token = app(DeviceTokenService::class)->issue($device)['token'];

    return ['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json'];
}

/** A print job that is ready to go out — rendered, queued, unclaimed. */
function readyJob(PosFixtures $fx, string $text = 'TICKET'): int
{
    return (int) DB::table('preparation_print_jobs')->insertGetId([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'job_type' => 'prep_new',
        'payload' => json_encode(['lines' => []]),
        'rendered_text' => $text,
        'copies' => 1,
        'state' => PrintJobState::Queued->value,
        'queued_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

function poll(array $headers): array
{
    return test()->withHeaders($headers)->getJson('/api/kitchen/print-jobs')->assertOk()->json('jobs');
}

function ack(array $headers, int $id, string $state, ?string $error = null)
{
    return test()->withHeaders($headers)
        ->postJson("/api/kitchen/print-jobs/{$id}/ack", ['state' => $state, 'error' => $error]);
}

it('claims a job on poll instead of handing it out unchanged', function (): void {
    $id = readyJob($this->fx);

    $jobs = poll($this->fx->headers());

    expect($jobs)->toHaveCount(1);

    $row = DB::table('preparation_print_jobs')->find($id);

    expect($row->state)->toBe(PrintJobState::Printing->value)
        ->and($row->leased_by)->toBe((string) $this->fx->device->uuid)
        ->and($row->leased_until)->not->toBeNull()
        ->and((int) $row->print_attempts)->toBe(1);
});

it('never gives the same job to two agents', function (): void {
    // The failure this whole mechanism exists for: one ticket, two agents, two copies on the pass.
    readyJob($this->fx);

    $first = poll($this->fx->headers());
    $second = poll(secondAgent($this->fx));

    expect($first)->toHaveCount(1)
        ->and($second)->toBe([]);
});

it('does not re-offer a job to the same agent polling twice', function (): void {
    // An agent polling on a timer while a long ticket prints must not be handed it again.
    readyJob($this->fx);

    expect(poll($this->fx->headers()))->toHaveCount(1)
        ->and(poll($this->fx->headers()))->toBe([]);
});

it('re-offers a job whose agent was killed, exactly once', function (): void {
    $id = readyJob($this->fx);

    poll($this->fx->headers());

    // The agent dies holding the lease: no ack, no release, and the lease simply runs out.
    DB::table('preparation_print_jobs')->where('id', $id)->update(['leased_until' => now()->subMinute()]);

    $second = secondAgent($this->fx);

    expect(poll($second))->toHaveCount(1);

    $row = DB::table('preparation_print_jobs')->find($id);

    expect($row->leased_by)->not->toBe((string) $this->fx->device->uuid)
        ->and((int) $row->print_attempts)->toBe(2);

    // Exactly once: having been reclaimed, it is not also still on offer to a third agent.
    expect(poll($this->fx->headers()))->toBe([]);
});

it('leaves a live lease alone even while another agent is polling hard', function (): void {
    readyJob($this->fx);
    poll($this->fx->headers());

    $second = secondAgent($this->fx);

    for ($i = 0; $i < 3; $i++) {
        expect(poll($second))->toBe([]);
    }
});

it('requeues a transient failure and parks it once the cap is reached', function (): void {
    config()->set('pos.kitchen.print_delivery_max_attempts', 3);
    $id = readyJob($this->fx);

    // Attempts 1 and 2 fail: the ticket goes back on the queue rather than being lost, which is
    // what terminal-on-first-failure used to do to one transient printer hiccup.
    foreach ([1, 2] as $attempt) {
        poll($this->fx->headers());
        ack($this->fx->headers(), $id, 'failed', 'paper out')->assertNoContent();

        $row = DB::table('preparation_print_jobs')->find($id);

        expect($row->state)->toBe(PrintJobState::Queued->value)
            ->and((int) $row->print_attempts)->toBe($attempt)
            ->and($row->leased_by)->toBeNull()
            ->and($row->last_error)->toBe('paper out');
    }

    // The third attempt hits the cap and parks it, visibly, with the reason attached.
    poll($this->fx->headers());
    ack($this->fx->headers(), $id, 'failed', 'paper out')->assertNoContent();

    $row = DB::table('preparation_print_jobs')->find($id);

    expect($row->state)->toBe(PrintJobState::Failed->value)
        ->and((int) $row->print_attempts)->toBe(3)
        ->and($row->last_error)->toBe('paper out');

    // Parked means parked: it is not handed out again forever.
    expect(poll($this->fx->headers()))->toBe([]);
});

it('records the print time and releases the lease on success', function (): void {
    $id = readyJob($this->fx);

    poll($this->fx->headers());
    ack($this->fx->headers(), $id, 'printed')->assertNoContent();

    $row = DB::table('preparation_print_jobs')->find($id);

    expect($row->state)->toBe(PrintJobState::Printed->value)
        ->and($row->printed_at)->not->toBeNull()
        ->and($row->leased_by)->toBeNull()
        ->and($row->leased_until)->toBeNull();
});

it('refuses a second ack and keeps the time the ticket actually printed', function (): void {
    // Delivery is at-least-once, so a duplicate ack is normal traffic, not misbehaviour. The old
    // code set `printed_at` to null on *every* non-printed ack — so one retrying agent erased the
    // record of a real print, and re-opened a ticket already sitting on the pass.
    $id = readyJob($this->fx);

    poll($this->fx->headers());
    ack($this->fx->headers(), $id, 'printed')->assertNoContent();

    $printedAt = DB::table('preparation_print_jobs')->where('id', $id)->value('printed_at');

    ack($this->fx->headers(), $id, 'failed', 'timeout')->assertStatus(409);

    $row = DB::table('preparation_print_jobs')->find($id);

    expect($row->state)->toBe(PrintJobState::Printed->value)
        ->and($row->printed_at)->toBe($printedAt)
        ->and($row->last_error)->toBeNull();
});

it('will not let one venue acknowledge another venue print job', function (): void {
    $other = PosFixtures::make();
    $id = readyJob($other);

    ack($this->fx->headers(), $id, 'printed')->assertNotFound();

    expect(DB::table('preparation_print_jobs')->where('id', $id)->value('state'))
        ->toBe(PrintJobState::Queued->value);
});

it('does not claim a job that has no text to print yet', function (): void {
    // Claiming an unrendered row would burn a delivery attempt on a ticket the agent could not
    // print, and three of those would park a ticket that never had anything wrong with it.
    $id = readyJob($this->fx);
    DB::table('preparation_print_jobs')->where('id', $id)->update(['rendered_text' => null]);

    expect(poll($this->fx->headers()))->toBe([]);

    $row = DB::table('preparation_print_jobs')->find($id);

    expect($row->state)->toBe(PrintJobState::Queued->value)
        ->and((int) $row->print_attempts)->toBe(0);
});

it('expires an abandoned lease but never a live one', function (): void {
    $abandoned = readyJob($this->fx, 'ABANDONED');
    $live = readyJob($this->fx, 'LIVE');

    poll($this->fx->headers());

    // Both were queued long ago; one agent has since died, the other is mid-ticket.
    DB::table('preparation_print_jobs')->whereIn('id', [$abandoned, $live])
        ->update(['queued_at' => now()->subHours(9)]);
    DB::table('preparation_print_jobs')->where('id', $abandoned)
        ->update(['leased_until' => now()->subHour()]);

    $this->artisan('pos:expire-print-jobs', ['--hours' => 6])->assertExitCode(0);

    expect(DB::table('preparation_print_jobs')->where('id', $abandoned)->value('state'))
        ->toBe(PrintJobState::Skipped->value);

    // A long ticket on a slow thermal printer is not an abandoned one. Reaping it mid-flight would
    // be the cleanup command causing the very failure it exists to clean up after.
    expect(DB::table('preparation_print_jobs')->where('id', $live)->value('state'))
        ->toBe(PrintJobState::Printing->value);
});

it('loses the race gracefully when another agent claims between the read and the write', function (): void {
    // The window the compare-and-set exists for, and the only place it can be observed: the poll
    // shortlists claimable rows, and a second agent can take one before this request's update runs.
    //
    // Simulated by stealing the row from inside a query listener, which fires once the shortlisting
    // SELECT has already returned it. The claiming UPDATE then finds the row no longer claimable and
    // reports zero rows affected — so this agent must return nothing, rather than print a ticket
    // another agent is already printing.
    $id = readyJob($this->fx);
    $stolen = false;

    DB::listen(function ($query) use ($id, &$stolen): void {
        if ($stolen || ! str_contains(strtolower($query->sql), 'select')) {
            return;
        }

        if (! str_contains($query->sql, 'preparation_print_jobs')) {
            return;
        }

        $stolen = true;

        DB::table('preparation_print_jobs')->where('id', $id)->update([
            'state' => PrintJobState::Printing->value,
            'leased_by' => 'another-agent',
            'leased_until' => now()->addMinutes(2),
            'print_attempts' => 1,
        ]);
    });

    expect(poll($this->fx->headers()))->toBe([]);

    $row = DB::table('preparation_print_jobs')->find($id);

    // Untouched by the loser: still held by the agent that actually won it, and not counted twice.
    expect($row->leased_by)->toBe('another-agent')
        ->and((int) $row->print_attempts)->toBe(1);
});
