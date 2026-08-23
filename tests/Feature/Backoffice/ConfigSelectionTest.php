<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\ConfigSelection;

use App\Models\Pos\PosBill;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosNote;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    // A decoy venue first, so the acting company is not id 1.
    PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs(User::factory()->create(['company_id' => $this->fx->company->getKey()]));
});

/** @param array<string, mixed> $payload */
function saveConfig(PosFixtures $fx, array $payload): TestResponse
{
    // Addressed by uuid, not by `route()` — these models bind by uuid but do not override
    // `getRouteKeyName()`, so the helper builds an id URL that 404s (the BAN-499 contract).
    return test()->patchJson("/pos-configs/{$fx->config->uuid}", $payload);
}

function makeNote(PosFixtures $fx, string $name): PosNote
{
    return PosNote::query()->create([
        'company_id' => $fx->company->getKey(),
        'name' => $name,
        'note_scope' => 'both',
        'color' => 0,
        'sequence' => 10,
        'active' => true,
    ]);
}

function makeBill(PosFixtures $fx, string $name, string $value): PosBill
{
    return PosBill::query()->create([
        'company_id' => $fx->company->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'name' => $name,
        'value' => $value,
        'denomination_type' => 'bill',
        'sequence' => 10,
        'active' => true,
    ]);
}

/**
 * BOF-039 / BOF-111 / BOF-112 (BAN-483) — which notes and denominations a register uses.
 *
 * Both pivots existed and neither had a door. `PosNote::posLoadScope` and `PosBill::posLoadScope`
 * already filter the bootstrap by them, with "no rows = every one the venue has" (the Odoo
 * semantics the migration records) — so the register was reading the fallback branch forever,
 * because nothing could write a row.
 */
it('attaches the notes a register offers', function (): void {
    $keep = makeNote($this->fx, 'No ice');
    makeNote($this->fx, 'Allergy - nuts');

    saveConfig($this->fx, ['note_ids' => [$keep->getKey()]])->assertRedirect();

    expect(DB::table('pos_config_note')->where('pos_config_id', $this->fx->config->getKey())
        ->pluck('pos_note_id')->all())->toBe([$keep->getKey()]);
});

it('attaches the denominations a register counts', function (): void {
    $twenty = makeBill($this->fx, 'EUR 20', '20.00');
    makeBill($this->fx, 'EUR 50', '50.00');

    saveConfig($this->fx, ['bill_ids' => [$twenty->getKey()]])->assertRedirect();

    expect(DB::table('pos_config_bill')->where('pos_config_id', $this->fx->config->getKey())
        ->pluck('pos_bill_id')->all())->toBe([$twenty->getKey()]);
});

it('keeps an unclaimed note global and hides a claimed one from other registers', function (): void {
    // The semantics are per *note*, not per config, and that is easy to read backwards. A row in
    // `pos_config_note` does not mean "this register shows this note" — it means "this note belongs
    // to these registers and to no others". A note nobody claims is shown everywhere, which is what
    // makes a seeded note usable without any setup.
    $claimed = makeNote($this->fx, 'No ice');
    makeNote($this->fx, 'Allergy - nuts');

    $second = PosFixtures::make();

    expect(PosNote::posLoadScope($this->fx->config)->pluck('name')->all())
        ->toContain('No ice')->toContain('Allergy - nuts');

    saveConfig($this->fx, ['note_ids' => [$claimed->getKey()]])->assertRedirect();

    // This register keeps both: the one it claimed, and the one nobody claimed.
    expect(PosNote::posLoadScope($this->fx->config->refresh())->pluck('name')->all())
        ->toContain('No ice')->toContain('Allergy - nuts');

    // A register of another venue sees neither — the claim is company-scoped as well.
    expect(PosNote::posLoadScope($second->config)->pluck('name')->all())
        ->not->toContain('No ice')->not->toContain('Allergy - nuts');
});

it('hides a claimed note from a sibling register that did not claim it', function (): void {
    // The half that makes the picker worth having: a note claimed by the bar does not appear on the
    // restaurant till.
    $claimed = makeNote($this->fx, 'Double shot');

    $sibling = PosConfig::query()->create([
        ...$this->fx->config->replicate(['uuid', 'access_token'])->getAttributes(),
        'uuid' => (string) Str::uuid(),
        'name' => 'Second till',
        'access_token' => Str::lower(Str::random(32)),
    ]);

    saveConfig($this->fx, ['note_ids' => [$claimed->getKey()]])->assertRedirect();

    expect(PosNote::posLoadScope($this->fx->config->refresh())->pluck('name')->all())
        ->toContain('Double shot')
        ->and(PosNote::posLoadScope($sibling)->pluck('name')->all())->not->toContain('Double shot');
});

it('applies the same claim rule to denominations', function (): void {
    // `PosBill::posLoadScope` has had this shape all along and the migration records it; the note
    // scope has been brought into line rather than the other way round.
    $twenty = makeBill($this->fx, 'EUR 20', '20.00');
    makeBill($this->fx, 'EUR 50', '50.00');

    $sibling = PosConfig::query()->create([
        ...$this->fx->config->replicate(['uuid', 'access_token'])->getAttributes(),
        'uuid' => (string) Str::uuid(),
        'name' => 'Second till',
        'access_token' => Str::lower(Str::random(32)),
    ]);

    saveConfig($this->fx, ['bill_ids' => [$twenty->getKey()]])->assertRedirect();

    expect(PosBill::posLoadScope($this->fx->config->refresh())->pluck('name')->all())
        ->toContain('EUR 20')->toContain('EUR 50')
        ->and(PosBill::posLoadScope($sibling)->pluck('name')->all())->not->toContain('EUR 20');
});

it('freezes the note list while a session is open', function (): void {
    // BOF-039. A predefined note is the wording the kitchen reads and, for an allergy, acts on.
    // Take one off mid-service and the next order that needs it gets a free-typed approximation, or
    // nothing — while orders already sent keep the text they were sent with, so the ticket in the
    // pass and the picker at the till stop agreeing about what the venue's notes are.
    $note = makeNote($this->fx, 'No ice');
    $this->fx->withSession();

    saveConfig($this->fx, ['note_ids' => [$note->getKey()]])->assertStatus(422);

    expect(DB::table('pos_config_note')->where('pos_config_id', $this->fx->config->getKey())->count())
        ->toBe(0);
});

it('still saves a note list that changes nothing while a session is open', function (): void {
    // The register settings page is one `useForm` and posts every field on every save, so a freeze
    // keyed on which keys *arrived* would refuse an unrelated edit — the defect this project has hit
    // twice already (BAN-396, BAN-424). Compared as a set, because neither side carries an ORDER BY.
    $first = makeNote($this->fx, 'No ice');
    $second = makeNote($this->fx, 'Allergy - nuts');

    saveConfig($this->fx, ['note_ids' => [$first->getKey(), $second->getKey()]])->assertRedirect();

    $this->fx->withSession();

    // The same selection, in the other order, alongside a real edit elsewhere.
    saveConfig($this->fx, [
        'note_ids' => [$second->getKey(), $first->getKey()],
        'receipt_header' => 'Merci !',
    ])->assertRedirect();

    expect((string) $this->fx->config->refresh()->receipt_header)->toBe('Merci !');
});

it('does not freeze the denominations, which are read at close', function (): void {
    // The count sheet is read when the session closes, so a correction made mid-shift lands on a
    // count that has not happened yet. Freezing it would mean noticing a missing denomination at
    // 6pm and being unable to fix it until after the count it is needed for.
    $bill = makeBill($this->fx, 'EUR 20', '20.00');
    $this->fx->withSession();

    saveConfig($this->fx, ['bill_ids' => [$bill->getKey()]])->assertRedirect();

    expect(DB::table('pos_config_bill')->where('pos_config_id', $this->fx->config->getKey())->count())
        ->toBe(1);
});

it('never attaches another company note', function (): void {
    $other = PosFixtures::make();
    $foreign = makeNote($other, 'Theirs');

    // Refused by name rather than silently dropped: ticking a box, seeing the save succeed and
    // finding the setting absent is the shape this project has fixed twice already.
    saveConfig($this->fx, ['note_ids' => [$foreign->getKey()]])->assertStatus(422);

    expect(DB::table('pos_config_note')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->where('pos_note_id', $foreign->getKey())->exists())->toBeFalse();
});

/**
 * Every pivot on this endpoint, not just the two this ticket added.
 *
 * `sync()` writes whatever ids it is handed, and all eleven took them straight from the request.
 * Probed on master: a foreign payment method and a foreign category both attached and the save
 * reported success. A foreign payment method appears on this register's payment screen and its
 * takings land in this venue's session; a foreign employee is granted till access nobody gave them.
 *
 * Parameterised over the five the fixtures can actually build a foreign row for. The other six —
 * pricelists, fiscal positions, presets, printers, notes, bills — go through the identical
 * `ownedIds()` call and every one of the eleven related models carries `BelongsToCompany`, which is
 * the scope doing the work.
 */
it('refuses another company id on the %s pivot', function (string $field, string $table, string $column, callable $foreignId): void {
    $other = PosFixtures::make()->withFloor()->withPrepDisplay();
    $id = $foreignId($other);

    expect($id)->toBeGreaterThan(0, 'the other venue must actually own one of these');

    saveConfig($this->fx, [$field => [$id]])->assertStatus(422);

    expect(DB::table($table)
        ->where('pos_config_id', $this->fx->config->getKey())
        ->where($column, $id)->exists())->toBeFalse();
})->with([
    ['payment_method_ids', 'pos_config_payment_method', 'payment_method_id',
        fn (PosFixtures $fx): int => (int) $fx->card->getKey()],
    ['limited_category_ids', 'pos_config_pos_category', 'pos_category_id',
        fn (PosFixtures $fx): int => (int) $fx->category->getKey()],
    ['employee_ids', 'pos_config_employee', 'employee_id',
        fn (PosFixtures $fx): int => (int) DB::table('employees')->where('company_id', $fx->company->getKey())->value('id')],
    ['floor_ids', 'pos_config_floor', 'restaurant_floor_id',
        fn (PosFixtures $fx): int => (int) $fx->floor->getKey()],
    ['prep_display_ids', 'pos_config_prep_display', 'prep_display_id',
        fn (PosFixtures $fx): int => (int) $fx->display->getKey()],
]);

it('still lets a register clear a pivot entirely', function (): void {
    // The empty list has to survive the ownership check, or "remove every note from this register"
    // becomes impossible — and an early return on `[]` is exactly the kind of branch a rewrite drops.
    $note = makeNote($this->fx, 'No ice');

    saveConfig($this->fx, ['note_ids' => [$note->getKey()]])->assertRedirect();
    expect(DB::table('pos_config_note')->where('pos_config_id', $this->fx->config->getKey())->count())->toBe(1);

    saveConfig($this->fx, ['note_ids' => []])->assertRedirect();
    expect(DB::table('pos_config_note')->where('pos_config_id', $this->fx->config->getKey())->count())->toBe(0);
});
