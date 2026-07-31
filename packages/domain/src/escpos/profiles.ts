import type { Codepage, ReceiptWidth } from './doc';

/**
 * Model-specific ESC/POS dialect (spec 03 §7.2).
 *
 * Everything a printer can disagree about lives here so the serializer stays branch-light:
 * codepage table ids, whether QR is native (`GS ( k`) or must be rasterised, the image command,
 * the cut command, drawer pin timing and the maximum raster width.
 */
export type PrinterProfileId = 'generic' | 'epson-tm-t20' | 'epson-tm-t88' | 'star-tsp100' | 'bixolon-srp350';

export type PrinterProfile = {
    id: PrinterProfileId;
    name: string;
    /** Default characters per line at font A. */
    width: ReceiptWidth;
    /** Printable dots across; a raster wider than this is downscaled by the caller. */
    dotWidth: number;
    defaultCodepage: Codepage;
    /** `ESC t n` table id per codepage. Missing ⇒ the codepage is unsupported on this model. */
    codepageIds: Partial<Record<Codepage, number>>;
    /** Native `GS ( k` QR support. When false the caller must supply a raster. */
    nativeQr: boolean;
    /** Native `GS k` barcodes. */
    nativeBarcode: boolean;
    /** `GS v 0` raster bit image. When false we fall back to `ESC *` column mode. */
    rasterGsV0: boolean;
    autoCut: boolean;
    /** `GS V m n` cut; `partial` leaves a tab so the roll does not fall on the floor. */
    partialCut: boolean;
    /** Cash-drawer pulse defaults, in ms/2 units as ESC p expects. */
    drawer: { pin: 0 | 1; on: number; off: number };
    /** Blank lines fed before the cut so the tear bar clears the text. */
    feedBeforeCut: number;
};

const BASE: Omit<PrinterProfile, 'id' | 'name'> = {
    width: 42,
    dotWidth: 512,
    defaultCodepage: 'cp858',
    codepageIds: { cp437: 0, cp850: 2, cp858: 19, cp1252: 16, utf8: 255 },
    nativeQr: true,
    nativeBarcode: true,
    rasterGsV0: true,
    autoCut: true,
    partialCut: true,
    drawer: { pin: 0, on: 25, off: 250 },
    feedBeforeCut: 4,
};

export const PRINTER_PROFILES: Record<PrinterProfileId, PrinterProfile> = {
    // Conservative: assume nothing beyond the 1993 command set.
    'generic': {
        ...BASE,
        id: 'generic',
        name: 'Generic ESC/POS',
        defaultCodepage: 'cp437',
        codepageIds: { cp437: 0, cp850: 2, cp1252: 16 },
        nativeQr: false,
    },
    'epson-tm-t20': { ...BASE, id: 'epson-tm-t20', name: 'Epson TM-T20' },
    'epson-tm-t88': { ...BASE, id: 'epson-tm-t88', name: 'Epson TM-T88' },
    'star-tsp100': {
        ...BASE,
        id: 'star-tsp100',
        name: 'Star TSP100 / mC-Print (ESC/POS mode)',
        // Star's ESC/POS emulation exposes a different codepage table and no partial cut by default.
        codepageIds: { cp437: 0, cp850: 2, cp858: 19, cp1252: 32 },
        partialCut: false,
    },
    'bixolon-srp350': {
        ...BASE,
        id: 'bixolon-srp350',
        name: 'Bixolon SRP-350',
        codepageIds: { cp437: 0, cp850: 2, cp858: 19, cp1252: 16 },
    },
};

export function resolveProfile(id: string | null | undefined): PrinterProfile {
    if (id && id in PRINTER_PROFILES) return PRINTER_PROFILES[id as PrinterProfileId];
    return PRINTER_PROFILES.generic;
}
