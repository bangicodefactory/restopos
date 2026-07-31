<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos\Concerns;

use App\Http\Middleware\AuthenticateDevice;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * Every register/kitchen endpoint is scoped to the *device's* config — never to
 * a config id in the URL. A device cannot address another register's data at
 * all, which removes an entire class of authorisation bug (spec 03 §2.2).
 */
trait ResolvesDeviceContext
{
    /** @return array{0: PosDevice, 1: PosConfig} */
    protected function deviceContext(Request $request): array
    {
        $device = $request->attributes->get(AuthenticateDevice::ATTRIBUTE);

        if (! $device instanceof PosDevice) {
            throw new HttpException(401, 'No device context on this request.');
        }

        /** @var PosConfig|null $config */
        $config = PosConfig::query()->find($device->pos_config_id);

        if ($config === null) {
            throw new HttpException(410, 'This device is attached to a config that no longer exists.');
        }

        return [$device, $config];
    }
}
