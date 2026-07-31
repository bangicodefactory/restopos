<?php

declare(strict_types=1);

namespace App\Http\Resources\SelfOrder;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * What a customer's phone may see about its own order (spec 02 SLF-090).
 *
 * Scoped by the order access token; it carries no other order, no employee, no
 * cost and no margin.
 *
 * @property array<string, mixed> $resource
 */
final class SelfOrderStatusResource extends JsonResource
{
    public static $wrap = null;

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var array<string, mixed> $payload */
        $payload = $this->resource;

        return $payload;
    }
}
