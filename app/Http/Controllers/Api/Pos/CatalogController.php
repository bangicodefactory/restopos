<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Services\Pos\BootstrapService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The lazy catalog endpoints (spec 01-schema §5.4).
 *
 * The register preloads a capped slice of products and customers; anything
 * beyond the cap is fetched on demand. Both endpoints are cursor-paginated on
 * the primary key — never `OFFSET`, which skips rows on a table being written
 * to while the cashier scrolls.
 */
final class CatalogController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly BootstrapService $bootstrap) {}

    /** `GET /api/pos/products?search=&category_id=&cursor=&limit=` */
    public function products(Request $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $request->validate([
            'search' => ['nullable', 'string', 'max:120'],
            'category_id' => ['nullable', 'integer'],
            'cursor' => ['nullable', 'string', 'max:64'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:500'],
        ]);

        $result = $this->bootstrap->searchProducts(
            config: $config,
            search: $request->query('search') === null ? null : (string) $request->query('search'),
            categoryId: $request->query('category_id') === null ? null : (int) $request->query('category_id'),
            cursor: $request->query('cursor') === null ? null : (string) $request->query('cursor'),
            limit: (int) $request->query('limit', (string) config('pos.bootstrap.search_page_size', 50)),
        );

        return new JsonResponse([
            'model' => 'products',
            'records' => $result['records'],
            'next_cursor' => $result['next_cursor'],
            'total' => $result['total'],
            'server_time' => now()->toIso8601ZuluString('microsecond'),
        ]);
    }

    /** `GET /api/pos/customers?search=&cursor=&limit=` */
    public function customers(Request $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $request->validate([
            'search' => ['nullable', 'string', 'max:120'],
            'cursor' => ['nullable', 'string', 'max:64'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:200'],
        ]);

        $result = $this->bootstrap->searchCustomers(
            config: $config,
            search: $request->query('search') === null ? null : (string) $request->query('search'),
            cursor: $request->query('cursor') === null ? null : (string) $request->query('cursor'),
            limit: (int) $request->query('limit', (string) config('pos.bootstrap.search_page_size', 50)),
        );

        return new JsonResponse([
            'model' => 'customers',
            'records' => $result['records'],
            'next_cursor' => $result['next_cursor'],
            'total' => $result['total'],
            'server_time' => now()->toIso8601ZuluString('microsecond'),
        ]);
    }
}
