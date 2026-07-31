<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Enums\SelfOrderMode;
use App\Models\Pos\PosConfig;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Services\SelfOrder\SelfOrderContext;
use Closure;
use Illuminate\Contracts\Container\Container;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Authenticates the anonymous self-order surface (spec 03 §2.4).
 *
 * Three tiers of bearer capability, all compared with `hash_equals`:
 *   - config token — `pos_configs.access_token`, in the path or `?t=`
 *   - table token  — `restaurant_tables.identifier`, in the path or `?tt=`
 *   - order token  — `pos_orders.access_token`, checked by the controllers
 *
 * The resolved {@see SelfOrderContext} is bound into the container so services
 * can take it as a dependency without reading the request.
 */
final class ResolveSelfOrderContext
{
    public const ATTRIBUTE = 'self_order_context';

    public function __construct(private readonly Container $container) {}

    public function handle(Request $request, Closure $next): Response
    {
        $token = (string) ($request->route('configToken') ?? $request->query('t', '') ?? '');

        if ($token === '') {
            return $this->deny('missing_config_token', 403);
        }

        /** @var PosConfig|null $config */
        $config = PosConfig::query()->where('access_token', $token)->first();

        if ($config === null || ! hash_equals((string) $config->access_token, $token)) {
            return $this->deny('invalid_config_token', 403);
        }

        if ($config->self_ordering_mode === SelfOrderMode::Nothing) {
            return $this->deny('self_order_disabled', 404);
        }

        $table = null;
        $tableToken = (string) ($request->route('tableToken') ?? $request->query('tt', '') ?? '');

        if ($tableToken !== '') {
            /** @var RestaurantTable|null $table */
            $table = RestaurantTable::query()->where('identifier', $tableToken)->first();

            if ($table === null || ! hash_equals((string) $table->identifier, $tableToken)) {
                return $this->deny('invalid_table_token', 403);
            }

            // Merged tables resolve to the physical parent so the cart lands on
            // the parent's order (spec 02 RST-050).
            $guard = 0;
            while ($table->parent_id !== null && $guard++ < 5) {
                $parent = RestaurantTable::query()->find($table->parent_id);
                if ($parent === null) {
                    break;
                }
                $table = $parent;
            }
        }

        $context = new SelfOrderContext($config, $table, $request->header('X-Order-Token'));

        $request->attributes->set(self::ATTRIBUTE, $context);
        $this->container->instance(SelfOrderContext::class, $context);

        return $next($request);
    }

    private function deny(string $code, int $status): JsonResponse
    {
        return new JsonResponse(['error' => ['code' => $code, 'message' => 'Self-order access denied.']], $status);
    }
}
