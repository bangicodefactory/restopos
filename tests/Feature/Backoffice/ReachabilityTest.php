<?php

declare(strict_types=1);

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use Tests\TestCase;

// No database: this reads the route table and a source file. `TestCase` is here only so the
// application is booted and `Route::getRoutes()` is populated.
uses(TestCase::class);

/**
 * Every back-office write has a door in the interface.
 *
 * This exists because the same defect shipped four times in a row. A ticket says "add create and
 * delete"; the routes, controller, policy, guards and feature tests all land; the page is never
 * touched. Everything is green, the ticket closes, and the capability is reachable by nobody —
 * `payment-methods.destroy`, `printers.store`, `floors.destroy`, `prep-displays.store` and
 * `taxes.store` all shipped that way, and the guards behind them protected nothing because nothing
 * could call them.
 *
 * Feature tests cannot catch it: they call the endpoint directly, which is exactly the thing the
 * operator cannot do. So the check is structural — a named write route must appear in the front
 * end's route table.
 *
 * This is a *reachability* check, not a proof the button works. It says the address is known to the
 * interface. Whether a control is rendered, and whether it is enabled, is what the page's own tests
 * and the manual are for.
 */
/**
 * Writes the back-office SPA legitimately does not call.
 *
 * Each entry needs a reason, and "not built yet" is not one — an unbuilt surface is what this test
 * is for. Add a ticket instead.
 *
 * @var array<string, string>
 */
$UNREACHED = [
    // Called by the register PWA and the pairing flow, not by the back office.
    'devices.pair' => 'the register pairs itself; the back office only revokes',
];

it('gives every back-office create and delete route a door in the interface', function () use ($UNREACHED): void {
    // Read here rather than at file scope: Pest loads the file before the application boots, and
    // `resource_path()` needs the container.
    $helpers = File::get(resource_path('js/backoffice/lib/routes.ts'));

    $missing = [];

    foreach (Route::getRoutes() as $route) {
        $name = $route->getName();

        if ($name === null || array_key_exists($name, $UNREACHED)) {
            continue;
        }

        if (! str_ends_with($name, '.store') && ! str_ends_with($name, '.destroy')) {
            continue;
        }

        // Back-office routes only: the API and the PWA shells build their own URLs.
        if (! in_array('web', $route->middleware(), true) || str_starts_with($route->uri(), 'api/')) {
            continue;
        }

        // `payment-methods.store` → `paymentMethods`, `.store`.
        [$resource, $action] = explode('.', $name, 2);
        $camel = lcfirst(str_replace(' ', '', ucwords(str_replace('-', ' ', $resource))));

        if (! str_contains($helpers, $camel.':')) {
            $missing[] = $name.' — no `'.$camel.'` block in routes.ts';

            continue;
        }

        // The helper block itself has to name the action, or the resource is only half-reachable.
        $block = Str::between($helpers, $camel.': {', '},');

        if (! str_contains($block, $action.':')) {
            $missing[] = $name.' — `'.$camel.'` exists but has no `'.$action.'` helper';
        }
    }

    expect($missing)->toBe([], "Write routes the interface cannot reach:\n  - ".implode("\n  - ", $missing));
});

it('has a reason recorded for every write the interface deliberately skips', function () use ($UNREACHED): void {
    // The escape hatch has to stay small and explained, or it becomes the place unreachable work
    // goes to be forgotten.
    foreach ($UNREACHED as $name => $reason) {
        expect(trim($reason))->not->toBe('', "{$name} is excluded with no reason given.");
    }

    expect(count($UNREACHED))->toBeLessThanOrEqual(5,
        'The exclusion list is growing. Each entry is a capability nobody can reach.');
});

it('has a page file for every component a controller renders', function (): void {
    // The other half of the same defect, and the sharper one: `PosBillController::index` rendered
    // `PosBills/Index` for weeks while no such file existed, so the route was not merely unreachable
    // — it was live and broken. Inertia resolves components in the browser, so nothing on the server
    // side notices, and a feature test asserting a 200 passes because the *server* rendered fine.
    $missing = [];

    foreach (File::allFiles(app_path('Http/Controllers')) as $file) {
        preg_match_all("/Inertia::render\('([^']+)'/", $file->getContents(), $matches);

        foreach ($matches[1] as $component) {
            $page = resource_path('js/backoffice/pages/'.$component.'.tsx');

            if (! File::exists($page)) {
                $missing[] = $component.' — rendered by '.$file->getFilename().', no page file';
            }
        }
    }

    expect($missing)->toBe([], "Components with no page:\n  - ".implode("\n  - ", $missing));
});
