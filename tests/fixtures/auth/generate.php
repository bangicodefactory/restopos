<?php

declare(strict_types=1);

/*
|--------------------------------------------------------------------------
| Provenance generator for pin-verifier.json (BAN-397)
|--------------------------------------------------------------------------
|
| Regenerates the shared offline-verifier parity corpus by reproducing the
| SERVER's real derivation chain, end to end:
|
|   app_key       = base64_decode(substr(APP_KEY, 7))                      (DeviceTokenService::appKey)
|   device_secret = HMAC-SHA256(app_key, "restopos:device-secret:{uuid}")  (DeviceTokenService::deviceSecret) -> 64-hex
|   pin_verifier  = HMAC-SHA256(device_secret, "pin:{id}:{sha256(pin)}")   (EmployeeAuthService::verifierFor)
|   badge_verifier= HMAC-SHA256(device_secret, "badge:{id}:{sha256(badge)}")
|
| The HMAC key at the verifier step is the device_secret HEX STRING's own
| bytes — matching PHP hash_hmac AND the client's TextEncoder().encode(secretHex)
| in resources/js/shared/auth/device.ts.
|
| Fixed app_key + uuid make device_secret deterministic and portable, so the PHP
| suite reaches the exact same secret through the real (final) DeviceTokenService
| without mocking, and the TS suite reads it as a constant.
|
| Run from the repo root, no bootstrap required:
|
|     php tests/fixtures/auth/generate.php > tests/fixtures/auth/pin-verifier.json
|
| Add or edit a case below, re-run, and commit both suites' green output. The PHP
| test self-checks that the real DeviceTokenService still reproduces `deviceSecret`,
| so a stale fixture fails loudly rather than rotting.
*/

$appKeyRaw = hash('sha256', 'ban-397-parity-fixture-app-key', true); // 32 deterministic bytes
$appKey = 'base64:'.base64_encode($appKeyRaw);
$deviceUuid = '00000000-0000-4000-8000-0000000b3970';

$deviceSecret = hash_hmac('sha256', 'restopos:device-secret:'.$deviceUuid, $appKeyRaw);

$cases = [
    ['kind' => 'pin',   'employeeId' => 1,  'secret' => '1234'],
    ['kind' => 'badge', 'employeeId' => 1,  'secret' => 'BADGE-A'],
    ['kind' => 'pin',   'employeeId' => 42, 'secret' => '0000'],                 // leading zeros
    ['kind' => 'pin',   'employeeId' => 7,  'secret' => '9999'],
    ['kind' => 'pin',   'employeeId' => 99, 'secret' => 'café'],                 // non-ASCII -> UTF-8 parity
    ['kind' => 'badge', 'employeeId' => 7,  'secret' => 'RFID-00-DE-AD-BE-EF'],
];

foreach ($cases as &$c) {
    $digest = hash('sha256', $c['secret']);                                       // employees.pin_hash / barcode_hash
    $c['verifier'] = hash_hmac('sha256', $c['kind'].':'.$c['employeeId'].':'.$digest, $deviceSecret);
}
unset($c);

$fixture = [
    'name' => 'pin-and-badge-verifier-parity',
    'description' => 'Cross-language parity for the offline employee verifier (spec 03 §2.3, BAN-397). '
        .'The server emits these verifiers for a known device_secret and known PIN/badge; the client '
        .'MUST reproduce the exact same hex or offline login is impossible. Read by BOTH '
        .'tests/Feature/BootstrapTest.php and resources/js/shared/auth/pin.test.ts. '
        .'Regenerate with `php tests/fixtures/auth/generate.php`.',
    'specRefs' => ['03 §2.3'],
    'deviceSecret' => $deviceSecret,
    'deviceSecretDerivation' => [
        'note' => 'device_secret = HMAC-SHA256(base64_decode(appKey without the base64: prefix), '
            .'"restopos:device-secret:"+deviceUuid). Lets the PHP suite reproduce device_secret through '
            .'the real DeviceTokenService instead of mocking a final class. The TS suite ignores these '
            .'and consumes deviceSecret directly. See tests/fixtures/auth/generate.php.',
        'appKey' => $appKey,
        'deviceUuid' => $deviceUuid,
    ],
    'cases' => $cases,
];

echo json_encode($fixture, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n";
