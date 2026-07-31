<?php

declare(strict_types=1);

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

it('redirects an anonymous visitor from the back-office to the login page', function (): void {
    $this->get('/')->assertRedirect('/login');
});

it('answers the liveness probe with the server clock and the version floor', function (): void {
    $this->getJson('/api/ping')
        ->assertOk()
        ->assertJsonPath('ok', true)
        ->assertJsonStructure(['ok', 'server_time', 'min_client_version', 'schema_version']);
});
