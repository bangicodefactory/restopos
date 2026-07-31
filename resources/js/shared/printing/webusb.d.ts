/**
 * Minimal WebUSB ambient declarations.
 *
 * `@types/w3c-web-usb` is not a dependency (packages/domain must stay dependency-free and the app
 * bundle should not carry types it uses in one file). Only the members `WebUsbTransport` actually
 * touches are declared, which also documents the surface we depend on.
 */

interface UsbEndpoint {
    endpointNumber: number;
    direction: 'in' | 'out';
    type: 'bulk' | 'interrupt' | 'isochronous';
}

interface UsbAlternateInterface {
    interfaceClass: number;
    interfaceSubclass: number;
    interfaceProtocol: number;
    endpoints: UsbEndpoint[];
}

interface UsbInterface {
    interfaceNumber: number;
    alternate: UsbAlternateInterface;
    claimed: boolean;
}

interface UsbConfiguration {
    configurationValue: number;
    interfaces: UsbInterface[];
}

interface UsbTransferResult {
    bytesWritten: number;
    status: 'ok' | 'stall' | 'babble';
}

interface USBDevice {
    readonly vendorId: number;
    readonly productId: number;
    readonly serialNumber?: string;
    readonly productName?: string;
    readonly manufacturerName?: string;
    readonly opened: boolean;
    readonly configuration: UsbConfiguration | null;
    open(): Promise<void>;
    close(): Promise<void>;
    selectConfiguration(value: number): Promise<void>;
    claimInterface(interfaceNumber: number): Promise<void>;
    releaseInterface(interfaceNumber: number): Promise<void>;
    transferOut(endpointNumber: number, data: BufferSource): Promise<UsbTransferResult>;
}

interface UsbDeviceFilter {
    vendorId?: number;
    productId?: number;
    classCode?: number;
    subclassCode?: number;
    protocolCode?: number;
    serialNumber?: string;
}

interface USB {
    getDevices(): Promise<USBDevice[]>;
    requestDevice(options: { filters: UsbDeviceFilter[] }): Promise<USBDevice>;
}

interface Navigator {
    readonly usb?: USB;
}
