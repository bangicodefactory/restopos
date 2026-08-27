<?php

declare(strict_types=1);

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * A host on the venue's own network, with an optional port (BAN-476).
 *
 * `proxy_ip` and `epos_printer_ip` are addresses a browser sitting on the till will fetch from. An
 * ePOS printer is reached over plain HTTP on the local network, so whatever is stored here is a URL
 * every till on this register will contact — with no certificate check to notice it changed.
 *
 * Left as a free string, a settings field becomes a stored SSRF: point it at an external host and
 * every till starts talking to it, sending whatever the print payload contains. The operator who
 * typed it sees nothing wrong, because printing "works" from the till's point of view right up until
 * it does not.
 *
 * So: a bare IPv4/IPv6 literal or a hostname, optionally with a port. **Not** a URL — no scheme, no
 * path, no credentials, no query. `http://user:pass@host/x?y` is a URL, and accepting one here is
 * how a field meant for `192.168.1.50` ends up holding a callback with an embedded token.
 *
 * This is a shape rule, not a network one. It cannot tell a LAN address from a public one — a venue
 * may legitimately run its IoT box behind a hostname that resolves anywhere — so it refuses what is
 * structurally not an address rather than pretending to know the network.
 */
final class LocalHost implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        $host = trim((string) $value);

        if ($host === '') {
            return;
        }

        if (preg_match('#[/\\\\@?\#\s]#', $host) === 1 || str_contains($host, '://')) {
            $fail('Enter an address such as 192.168.1.50 or printer.local, optionally with a port —'
                .' not a full URL.');

            return;
        }

        [$name, $port] = $this->split($host);

        if ($port !== null && ($port < 1 || $port > 65535)) {
            $fail('That port number is not a real one.');

            return;
        }

        $isIp = filter_var($name, FILTER_VALIDATE_IP) !== false;
        // Deliberately permissive on hostnames: `printer.local`, `iotbox`, and a venue's own
        // internal domain are all ordinary here.
        $isHostname = preg_match('/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i', $name) === 1;

        if (! $isIp && ! $isHostname) {
            $fail('That does not look like an address. Use something like 192.168.1.50 or printer.local.');
        }
    }

    /**
     * @return array{0: string, 1: ?int}
     */
    private function split(string $host): array
    {
        // `[::1]:8080` — a bracketed IPv6 literal with a port.
        if (str_starts_with($host, '[')) {
            $close = strpos($host, ']');

            if ($close === false) {
                return [$host, null];
            }

            $name = substr($host, 1, $close - 1);
            $rest = substr($host, $close + 1);

            return [$name, str_starts_with($rest, ':') ? (int) substr($rest, 1) : null];
        }

        // A bare IPv6 literal has several colons and no port; `1.2.3.4:80` has exactly one.
        if (substr_count($host, ':') === 1) {
            [$name, $port] = explode(':', $host, 2);

            return [$name, ctype_digit($port) ? (int) $port : -1];
        }

        return [$host, null];
    }
}
