<?php

declare(strict_types=1);

// Own namespace so the scanner helpers below do not pollute the global function table (Pest loads
// every test file into one process). The Pest DSL (`uses`, `it`, `expect`) and PHP built-ins
// resolve via the global-namespace fallback.
namespace Tests\Feature\RouteContract;

use Illuminate\Support\Facades\Route;
use Symfony\Component\Finder\Finder;
use Tests\TestCase;

uses(TestCase::class);

/*
|--------------------------------------------------------------------------
| Path contract (spec §2.16)
|--------------------------------------------------------------------------
|
| Every API path the client (`resources/js`) references must resolve to a route
| registered under `routes/api.php`. This is the regression guard for the
| cold-start class of bug (BAN-394): the client asked for
| `GET /api/pos/{configId}/bootstrap` while the shipped route is device-scoped
| (`GET /api/pos/bootstrap`, no config id in the path), so every fresh register
| 404'd. The delta puller had the identical defect, and the reachability probe a
| third (`/api/pos/ping` vs the shipped `/api/ping`). All three share one root
| cause — client and route disagreeing on a string — and all three would have
| been caught on the first run by this test.
|
| Scope: the request PATH only (a route existing does not prove the method,
| middleware or payload are right — those are covered by the endpoint tests).
| A client path with a dynamic `${…}` segment matches a route `{param}`, but a
| dynamic client segment does not stand in for a route *literal* — so an extra or
| misplaced segment is caught rather than absorbed by a same-length route.
|
| Only string/template literals passed to the ApiClient (or absolute `/api/…`
| literals) are scanned; a path assembled from variables is invisible here.
*/

/** @return list<list<string>> Each api route as segments; a `{param}` segment becomes `*`. */
function apiRoutePatterns(): array
{
    $patterns = [];

    foreach (Route::getRoutes() as $route) {
        $uri = $route->uri();

        // Only `/api/**` — Broadcasting's `broadcasting/auth` and web routes are out of scope.
        if ($uri !== 'api' && ! str_starts_with($uri, 'api/')) {
            continue;
        }

        $rel = ltrim(substr($uri, 3), '/'); // drop the leading `api`
        $segments = $rel === '' ? [] : explode('/', $rel);

        $patterns[] = array_map(
            static fn (string $seg): string => preg_match('/^\{.+\}$/', $seg) === 1 ? '*' : $seg,
            $segments,
        );
    }

    return $patterns;
}

/** The distinct first segments of the api routes — used to tell an API call from a `Map.get()`. */
function apiTopLevelSegments(array $patterns): array
{
    $tops = [];
    foreach ($patterns as $segments) {
        if ($segments !== [] && $segments[0] !== '*') {
            $tops[$segments[0]] = true;
        }
    }

    return array_keys($tops);
}

/** Normalise a client path literal to api-relative segments (`${…}` → `*`), or null if not an API path. */
function normaliseClientPath(string $raw, array $tops): ?array
{
    // A literal `*` marks a glob or documentation pattern (a service-worker route, a doc comment
    // like `/api/kitchen/*`), never a concrete request path — the `${…}` → `*` normalisation below
    // is the only thing that introduces a wildcard segment.
    if (str_contains($raw, '*')) {
        return null;
    }

    $path = strtok($raw, '?');           // drop any query string
    $path = preg_replace('/\$\{[^}]*\}/', '*', $path); // template expr → wildcard segment
    $path = ltrim((string) $path, '/');
    if (str_starts_with($path, 'api/')) {
        $path = substr($path, 4);        // absolute `/api/…` form
    }
    $path = rtrim($path, '/');
    if ($path === '') {
        return null;
    }

    $segments = array_map(
        static fn (string $seg): string => str_contains($seg, '*') ? '*' : $seg,
        explode('/', $path),
    );

    // Only treat it as an API path if its first segment is a real api route prefix; this keeps
    // `map.get('some-key')` / `db.table.get(id)` out while still catching a wrong path under a
    // valid prefix (e.g. `pos/ping`, `pos/*/bootstrap`).
    return in_array($segments[0], $tops, true) ? $segments : null;
}

/** True if a client path (segments, `*` wildcards) matches any registered route pattern. */
function clientPathResolves(array $client, array $patterns): bool
{
    foreach ($patterns as $pattern) {
        if (count($pattern) !== count($client)) {
            continue;
        }
        $matched = true;
        foreach ($pattern as $i => $routeSeg) {
            $clientSeg = $client[$i];
            // A route param (`*`) accepts any client segment. Otherwise a route *literal* must equal
            // the client segment exactly — a client dynamic segment (`*`) does NOT satisfy a route
            // literal. That asymmetry is the point: without it, `pos/*/bootstrap` would borrow a
            // same-length route like `pos/orders/{order}` and the cold-start regression would pass.
            if ($routeSeg !== '*' && $routeSeg !== $clientSeg) {
                $matched = false;
                break;
            }
        }
        if ($matched) {
            return true;
        }
    }

    return false;
}

/** @return array<string, array{path: string, file: string}> Distinct client api paths → where they were found. */
function clientApiPathReferences(array $tops): array
{
    $files = Finder::create()
        ->files()
        ->in(base_path('resources/js'))
        ->name(['*.ts', '*.tsx'])
        ->notName(['*.test.ts', '*.test.tsx', '*.d.ts'])
        ->exclude(['__fixtures__', '__mocks__']);

    // `.get('…')` / `.post('…')` — path is the first string argument.
    $getPost = '/\.(?:get|post)(?![A-Za-z0-9_])\s*(?:<[^>]*>)?\s*\(\s*([\'"`])([^\'"`]+)\1/';
    // `.request('METHOD', '…')` — path is the second string argument.
    $request = '/\.request(?![A-Za-z0-9_])\s*(?:<[^>]*>)?\s*\(\s*[\'"`][A-Z]+[\'"`]\s*,\s*([\'"`])([^\'"`]+)\1/';
    // Absolute `'/api/…'` literals (e.g. the reachability probe's `fetch`). Single/double quotes
    // only — NOT backticks: JSDoc inline code-spans use backticks (`/api/kitchen/*`) and are
    // documentation, not calls; real absolute request paths are plain quoted string literals.
    $absolute = '/([\'"])(\/api\/[^\'"?\s]*)\1/';

    $refs = [];

    foreach ($files as $file) {
        $src = $file->getContents();
        $rel = str_replace('\\', '/', substr($file->getPathname(), strlen(base_path()) + 1));

        foreach ([[$getPost, 2], [$request, 2], [$absolute, 2]] as [$regex, $group]) {
            preg_match_all($regex, $src, $matches);
            foreach ($matches[$group] as $raw) {
                $segments = normaliseClientPath($raw, $tops);
                if ($segments === null) {
                    continue;
                }
                $key = implode('/', $segments);
                $refs[$key] ??= ['path' => $raw, 'file' => $rel, 'segments' => $segments];
            }
        }
    }

    return $refs;
}

it('every api path referenced by the client resolves to a route in routes/api.php', function (): void {
    $patterns = apiRoutePatterns();
    $tops = apiTopLevelSegments($patterns);

    expect($tops)->not->toBeEmpty('No `api/*` routes were registered — is routes/api.php loaded?');

    $refs = clientApiPathReferences($tops);

    // Sanity: the scanner must actually find the core client endpoints, or the regex has rotted.
    expect(array_keys($refs))->toContain('pos/bootstrap', 'pos/delta');

    $unresolved = [];
    foreach ($refs as $ref) {
        if (! clientPathResolves($ref['segments'], $patterns)) {
            $canonical = implode('/', $ref['segments']);
            $unresolved[] = "  /api/{$canonical}   (referenced as `{$ref['path']}` in {$ref['file']})";
        }
    }

    expect($unresolved)->toBe(
        [],
        "Client references API paths with no matching route in routes/api.php:\n".implode("\n", $unresolved),
    );
});
