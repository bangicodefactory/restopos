<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PosNoteCrud;

use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pos\PosNote;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * A real permissioned user rather than a super-admin, which bypasses the policy entirely.
 *
 * @param  list<string>  $permissions
 */
function noteActor(PosFixtures $fx, array $permissions): User
{
    $role = Role::query()->create([
        'name' => 'Config manager',
        'slug' => 'config-manager-'.Str::random(6),
        'is_system' => false,
    ]);

    foreach ($permissions as $slug) {
        $permission = Permission::query()->firstOrCreate(['slug' => $slug], ['group' => 'config']);
        DB::table('permission_role')->insertOrIgnore([
            'role_id' => $role->getKey(),
            'permission_id' => $permission->getKey(),
        ]);
    }

    $user = User::factory()->create(['company_id' => $fx->company->getKey(), 'is_super_admin' => false]);
    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

    return $user;
}

beforeEach(function (): void {
    PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs(noteActor($this->fx, ['backoffice.access', 'backoffice.manage_configs']));
});

/** @param array<string, mixed> $payload */
function addNote(array $payload = []): TestResponse
{
    return test()->post(route('pos-notes.store'), [
        'name' => 'No ice',
        'note_scope' => 'line',
        ...$payload,
    ]);
}

/**
 * BOF-112 (BAN-483) — the predefined kitchen notes.
 *
 * The notes a waiter picks rather than types: "no ice", "allergy — nuts". The table and the model
 * existed and nothing could author them, so the list was the seeder's and a venue could not add the
 * one note its own kitchen needs.
 *
 * The register already loads them and the ticket already prints them (BAN-485); this is the surface
 * that fills the table. Addressed by **id** — `pos_notes` carries no uuid column.
 */
it('authors a note', function (): void {
    addNote()->assertRedirect();

    expect(PosNote::query()->where('name', 'No ice')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addNote()->assertRedirect();

    expect((int) PosNote::query()->where('name', 'No ice')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('records where the note can be attached', function (): void {
    // Line or order. Getting it wrong puts "table is in a hurry" on one drink, or "no ice" on the
    // whole bill — either way the kitchen ticket says something nobody meant.
    addNote(['name' => 'In a hurry', 'note_scope' => 'order'])->assertRedirect();

    expect((string) PosNote::query()->where('name', 'In a hurry')->value('note_scope')->value)->toBe('order');
});

it('refuses a scope the ticket cannot place', function (): void {
    addNote(['note_scope' => 'somewhere'])->assertSessionHasErrors('note_scope');
});

it('refuses a second note with the same name', function (): void {
    // Two notes reading "no ice" in one picker is a picker nobody trusts — and the table's unique
    // index would refuse it anyway, as a 500 rather than a message.
    addNote()->assertRedirect();

    addNote()->assertSessionHasErrors('name');

    expect(PosNote::query()->where('name', 'No ice')->count())->toBe(1);
});

it('lets another company use the same name', function (): void {
    // The uniqueness is per company, not global. One venue's "no ice" is not another's.
    //
    // Posted **through the endpoint as that company's user**, because the rule is what is being
    // tested: creating the row directly would exercise the table's unique index and nothing else,
    // and a sabotage making the rule global passed until this went through the door (review of #79).
    $other = PosFixtures::make();

    addNote()->assertRedirect();

    test()->actingAs(noteActor($other, ['backoffice.access', 'backoffice.manage_configs']));
    addNote()->assertRedirect();

    expect(PosNote::query()->withoutGlobalScopes()->where('name', 'No ice')->count())->toBe(2);
});

it('lets a note keep its own name when edited', function (): void {
    // The uniqueness rule must ignore the row being edited, or changing a note's colour fails on its
    // own name.
    addNote()->assertRedirect();
    $note = PosNote::query()->where('name', 'No ice')->firstOrFail();

    test()->patch(route('pos-notes.update', $note->getKey()), ['name' => 'No ice', 'color' => 3])
        ->assertRedirect();

    expect((int) PosNote::query()->whereKey($note->getKey())->value('color'))->toBe(3);
});

it('removes a note', function (): void {
    addNote()->assertRedirect();
    $note = PosNote::query()->where('name', 'No ice')->firstOrFail();

    test()->delete(route('pos-notes.destroy', $note->getKey()))->assertRedirect();

    expect(PosNote::query()->whereKey($note->getKey())->exists())->toBeFalse();
});

it('never touches another company note', function (): void {
    $other = PosFixtures::make();

    $theirs = PosNote::query()->create([
        'company_id' => $other->company->getKey(),
        'name' => 'Their note',
        'note_scope' => 'line',
        'color' => 0,
        'sequence' => 1,
        'active' => true,
    ]);

    test()->delete(route('pos-notes.destroy', $theirs->getKey()))->assertNotFound();

    expect(PosNote::query()->withoutGlobalScopes()->whereKey($theirs->getKey())->exists())->toBeTrue();
});

it('refuses a user who may not configure the register', function (): void {
    addNote()->assertRedirect();
    $note = PosNote::query()->where('name', 'No ice')->firstOrFail();

    test()->actingAs(noteActor($this->fx, ['backoffice.access']));

    addNote(['name' => 'Sneaky'])->assertForbidden();
    test()->delete(route('pos-notes.destroy', $note->getKey()))->assertForbidden();

    expect(PosNote::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and(PosNote::query()->whereKey($note->getKey())->exists())->toBeTrue();
});

it('reaches the register, which is the only reason this surface exists', function (): void {
    addNote()->assertRedirect();

    $fx = $this->fx->withSession();
    $note = PosNote::query()->where('name', 'No ice')->firstOrFail();
    $fx->config->notes()->syncWithoutDetaching([$note->getKey()]);

    $notes = test()->withHeaders($fx->headers())->getJson('/api/pos/bootstrap')
        ->assertOk()
        ->json('data.pos_notes');

    expect(collect($notes)->pluck('name'))->toContain('No ice');
});
