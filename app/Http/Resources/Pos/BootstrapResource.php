<?php

declare(strict_types=1);

namespace App\Http\Resources\Pos;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * The bootstrap / delta envelope (spec 01-schema §5.8).
 *
 * `BootstrapService` produces the array; this Resource exists so the wire shape
 * has exactly one definition and the front-end contract in
 * `docs/spec/05-api-contract.md` has exactly one thing to describe.
 *
 * @property array<string, mixed> $resource
 */
final class BootstrapResource extends JsonResource
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
