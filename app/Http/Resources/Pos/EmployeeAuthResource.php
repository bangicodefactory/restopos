<?php

declare(strict_types=1);

namespace App\Http\Resources\Pos;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * One employee's offline auth record (spec 03 §2.3).
 *
 * The plaintext PIN never leaves the device and `employees.pin_hash` never
 * leaves the server; what travels is an HMAC keyed by *this device's* secret,
 * so a bootstrap payload lifted from one terminal is useless on another.
 *
 * @property array<string, mixed> $resource
 */
final class EmployeeAuthResource extends JsonResource
{
    public static $wrap = null;

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var array<string, mixed> $data */
        $data = $this->resource;

        return $data;
    }
}
