import { WebSerialScaleTransport } from './web-serial';
import type { ScaleTransport, ScaleTransportKind } from './types';

/**
 * Which transport, if any, this till should talk to (XCT-058).
 *
 * The injectable map mirrors `shared/printing/router.ts` — a test hands in a fake under the kind it
 * wants and gets the production selection logic, rather than a mock of it.
 *
 * **The gate is `iot_scale`, and that choice is the point of this function.** Spec 03 §7.7 names
 * `iface_electronic_scale`, and Odoo does gate on that; here it is a field declared in
 * `packages/domain/src/types.ts` with **no `pos_configs` column, no cast, no validation rule and no
 * server writer** — grep it: two hits, a type and a test fixture. Reading it would produce
 * `undefined` on every till forever, which is a driver that can never turn on.
 *
 * `iot_scale` is the column that exists. Before this ticket it was a *fully wired dead toggle*:
 * migration, cast, request validation, a switch in the back office, a feature test asserting it
 * persists, a declaration in the TS type, and shipped to every till on every bootstrap — and
 * `grep -rn iot_scale resources/js/register` returned exactly one hit, a fixture. A manager could
 * turn it on and nothing anywhere would behave differently. This is the code that reads it.
 */
export type ScaleTransportMap = Partial<Record<ScaleTransportKind, ScaleTransport>>;

export type ScaleGateConfig = {
    /** `pos_configs.iot_scale`. Null/undefined config means no scale, not a default-on scale. */
    iot_scale?: boolean;
} | null;

export function resolveScaleTransport(
    config: ScaleGateConfig,
    transports: ScaleTransportMap = { webserial: new WebSerialScaleTransport() },
    preference: readonly ScaleTransportKind[] = ['webserial', 'proxy', 'fake'],
): ScaleTransport | null {
    if (config?.iot_scale !== true) return null;

    for (const kind of preference) {
        const transport = transports[kind];
        if (transport && transport.isAvailable()) return transport;
    }

    return null;
}
