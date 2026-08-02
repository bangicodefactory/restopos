<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-499 — back-office model-bound routes resolve `HasUuid` models by `uuid`, so their pages must
 * be reached with the record's uuid, not its numeric id. These are the smoke tests the ticket asks
 * for: each editor/show route returns 200 for a real record addressed by uuid, and (to pin the
 * contract that made the front end 404) the same route addressed by id is not found.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withFloor()->withPrepDisplay()->withSession();
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));
});

it('resolves every uuid-bound back-office page for a real record', function (): void {
    $fx = $this->fx;

    $this->get("/pos-configs/{$fx->config->uuid}/edit")->assertOk();
    $this->get("/self-order/{$fx->config->uuid}/settings")->assertOk();
    $this->get("/products/{$fx->product->uuid}/edit")->assertOk();
    $this->get("/floors/{$fx->floor->uuid}/edit")->assertOk();
    $this->get("/prep-displays/{$fx->display->uuid}/edit")->assertOk();
    $this->get("/sessions/{$fx->session->uuid}")->assertOk();
});

it('404s when a uuid-bound page is addressed by numeric id (the bug that shipped)', function (): void {
    // The front end used to build these with `id`; binding is by uuid, so it never resolved.
    $this->get("/floors/{$this->fx->floor->getKey()}/edit")->assertNotFound();
    $this->get("/products/{$this->fx->product->getKey()}/edit")->assertNotFound();
});
