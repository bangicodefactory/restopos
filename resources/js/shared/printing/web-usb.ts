import { drawerKickDoc, resolveProfile, toEscPos, type EscPosDoc } from '@domain/escpos/index';

import { printError, type PrintOutcome, type PrintTransport, type PrinterBinding } from './types';

/**
 * WebUSB transport (spec 03 §7.3, transport 2).
 *
 * Zero infrastructure, works on Chromium desktop and Android. Two costs, both documented for
 * support: a user gesture is required per device grant (persisted afterwards), and on Windows the
 * printer must not be claimed by a kernel driver — practically "install as a generic USB device".
 *
 * The device handle cannot be persisted, only the *grant* can. So we re-resolve the device from
 * `navigator.usb.getDevices()` on every boot, matching on the signature stored in the binding.
 */

const PRINTER_CLASS = 7;
const CHUNK_SIZE = 4096;

export function usbSignature(device: USBDevice): string {
    return [device.vendorId, device.productId, device.serialNumber ?? ''].join(':');
}

function* chunked(bytes: Uint8Array, size: number): Generator<Uint8Array> {
    for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
    }
}

export class WebUsbTransport implements PrintTransport {
    readonly kind = 'webusb' as const;

    private readonly claimed = new Map<string, { device: USBDevice; interfaceNumber: number; endpoint: number }>();

    isAvailable(): boolean {
        return typeof globalThis.navigator?.usb?.getDevices === 'function';
    }

    /** Must be called from a user gesture. Returns the signature to store on the binding. */
    async requestDevice(): Promise<string | null> {
        const usb = globalThis.navigator?.usb;
        if (!usb) return null;
        try {
            const device = await usb.requestDevice({ filters: [{ classCode: PRINTER_CLASS }] });
            return usbSignature(device);
        } catch {
            return null;
        }
    }

    async listGranted(): Promise<Array<{ signature: string; label: string }>> {
        const usb = globalThis.navigator?.usb;
        if (!usb) return [];
        const devices = await usb.getDevices();
        return devices.map((device) => ({
            signature: usbSignature(device),
            label: [device.manufacturerName, device.productName].filter(Boolean).join(' ') || 'USB printer',
        }));
    }

    async print(doc: EscPosDoc, binding: PrinterBinding): Promise<PrintOutcome> {
        return this.write(toEscPos(doc, resolveProfile(binding.profile)), binding);
    }

    async openDrawer(binding: PrinterBinding): Promise<PrintOutcome> {
        return this.write(toEscPos(drawerKickDoc(), resolveProfile(binding.profile)), binding);
    }

    private async write(bytes: Uint8Array, binding: PrinterBinding): Promise<PrintOutcome> {
        const usb = globalThis.navigator?.usb;
        if (!usb) {
            return {
                ok: false,
                transport: this.kind,
                printerId: binding.id,
                error: printError('unsupported', 'WebUSB is not available in this browser', false),
            };
        }

        try {
            const handle = await this.claim(binding);
            if (!handle) {
                return {
                    ok: false,
                    transport: this.kind,
                    printerId: binding.id,
                    error: printError('permission', 'USB printer not granted or not connected', false),
                };
            }

            for (const chunk of chunked(bytes, CHUNK_SIZE)) {
                const result = await handle.device.transferOut(handle.endpoint, chunk as unknown as BufferSource);
                if (result.status !== 'ok') {
                    return {
                        ok: false,
                        transport: this.kind,
                        printerId: binding.id,
                        error: printError('unknown', `USB transfer ${result.status}`),
                    };
                }
            }

            return { ok: true, transport: this.kind, printerId: binding.id };
        } catch (error) {
            // A disconnect invalidates the handle; drop it so the next attempt re-resolves.
            this.claimed.delete(binding.address);
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                transport: this.kind,
                printerId: binding.id,
                error: printError(/security|denied/i.test(message) ? 'permission' : 'unreachable', message),
            };
        }
    }

    private async claim(
        binding: PrinterBinding,
    ): Promise<{ device: USBDevice; interfaceNumber: number; endpoint: number } | null> {
        const cached = this.claimed.get(binding.address);
        if (cached?.device.opened) return cached;

        const usb = globalThis.navigator?.usb;
        if (!usb) return null;

        const devices = await usb.getDevices();
        const device = devices.find((d) => usbSignature(d) === binding.address) ?? devices[0];
        if (!device) return null;

        if (!device.opened) await device.open();
        if (device.configuration === null) await device.selectConfiguration(1);

        const iface = device.configuration?.interfaces.find(
            (i) => i.alternate.interfaceClass === PRINTER_CLASS,
        );
        if (!iface) return null;

        if (!iface.claimed) await device.claimInterface(iface.interfaceNumber);

        const endpoint = iface.alternate.endpoints.find((e) => e.direction === 'out');
        if (!endpoint) return null;

        const handle = { device, interfaceNumber: iface.interfaceNumber, endpoint: endpoint.endpointNumber };
        this.claimed.set(binding.address, handle);
        return handle;
    }

    /** Release every claimed interface — called on `pagehide` so a reload can re-claim. */
    async release(): Promise<void> {
        for (const handle of this.claimed.values()) {
            try {
                await handle.device.releaseInterface(handle.interfaceNumber);
                await handle.device.close();
            } catch {
                // The device is already gone; nothing to release.
            }
        }
        this.claimed.clear();
    }
}
