<?php

declare(strict_types=1);

namespace App\Http\Resources\Kitchen;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * The KDS board payload (spec 01-schema §5.7): cards, their lines and the
 * display's stage definitions. No prices, no customers, no payments — a kitchen
 * screen is a shared device in a room strangers walk through.
 *
 * @property array<string, mixed> $resource
 */
final class PrepBoardResource extends JsonResource
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
