/**
 * A QR encoder, in about three hundred lines and zero dependencies.
 *
 * Self-order needs a printable QR per table (`/menu/{configToken}?tt={tableToken}`) and per
 * venue. Pulling in a QR library for that would add a dependency to a project whose whole client
 * story is "no runtime dependencies we did not write", so the encoder lives here.
 *
 * Scope, chosen to be exactly what the payload needs and nothing more:
 *
 *  - **byte mode** only (URLs are UTF-8, and byte mode encodes any of them);
 *  - **error-correction level M** (~15% recovery — the level printed QR codes on paper menus
 *    want, since a smudge is the expected failure, not a tear);
 *  - **versions 1–10**, i.e. up to 216 bytes, which covers every URL this app generates.
 *
 * Everything else — mask selection by the four ISO/IEC 18004 penalty rules, the BCH format and
 * version bit strings, Reed-Solomon over GF(2⁸) with the standard 0x11D primitive — is the real
 * algorithm, not an approximation. A QR that "usually scans" is worse than no QR: it fails in the
 * customer's hands, at the table, with no way to tell them why.
 */

export type QrMatrix = {
    /** Modules per side, excluding the quiet zone. */
    size: number;
    /** Row-major, 1 = dark. */
    modules: Uint8Array;
    version: number;
};

/** Error-correction codewords per block, level M, versions 1–10. */
const ECC_CODEWORDS_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** Blocks per version, level M, versions 1–10. */
const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

const MIN_VERSION = 1;
const MAX_VERSION = 10;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export class QrTooLongError extends Error {
    constructor(byteLength: number) {
        super(`QR payload of ${byteLength} bytes exceeds the 216-byte level-M version-10 limit.`);
        this.name = 'QrTooLongError';
    }
}

/** Total codewords (data + ECC) a version holds. */
function rawCodewords(version: number): number {
    let modules = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const numAlign = Math.floor(version / 7) + 2;
        modules -= (25 * numAlign - 10) * numAlign - 55;
        if (version >= 7) modules -= 36;
    }
    return Math.floor(modules / 8);
}

function dataCodewords(version: number): number {
    const index = version - 1;
    return (
        rawCodewords(version) - (ECC_CODEWORDS_PER_BLOCK[index] ?? 0) * (NUM_BLOCKS[index] ?? 1)
    );
}

/** Byte-mode character count is 8 bits up to version 9, 16 bits from version 10. */
function charCountBits(version: number): number {
    return version <= 9 ? 8 : 16;
}

// ───────────────────────────────────────────────────────────── GF(2⁸) arithmetic

function gfMultiply(x: number, y: number): number {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function reedSolomonDivisor(degree: number): Uint8Array {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMultiply(result[j] ?? 0, root);
            if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function reedSolomonRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
    const result = new Uint8Array(divisor.length);
    for (const byte of data) {
        const factor = byte ^ (result[0] ?? 0);
        result.copyWithin(0, 1);
        result[result.length - 1] = 0;
        for (let i = 0; i < result.length; i++) {
            result[i] = (result[i] ?? 0) ^ gfMultiply(divisor[i] ?? 0, factor);
        }
    }
    return result;
}

// ───────────────────────────────────────────────────────────── bit stream

class BitBuffer {
    private readonly bits: number[] = [];

    append(value: number, length: number): void {
        for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    }

    get length(): number {
        return this.bits.length;
    }

    toBytes(): Uint8Array {
        const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
        this.bits.forEach((bit, index) => {
            if (bit === 1) bytes[index >>> 3] = (bytes[index >>> 3] ?? 0) | (0x80 >>> (index & 7));
        });
        return bytes;
    }
}

function chooseVersion(byteLength: number): number {
    for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
        const capacityBits = dataCodewords(version) * 8;
        if (4 + charCountBits(version) + byteLength * 8 <= capacityBits) return version;
    }
    throw new QrTooLongError(byteLength);
}

function buildDataCodewords(payload: Uint8Array, version: number): Uint8Array {
    const capacity = dataCodewords(version);
    const buffer = new BitBuffer();

    buffer.append(0b0100, 4); // byte mode
    buffer.append(payload.length, charCountBits(version));
    for (const byte of payload) buffer.append(byte, 8);

    // Terminator, then pad to a byte boundary, then the alternating pad bytes.
    buffer.append(0, Math.min(4, capacity * 8 - buffer.length));
    buffer.append(0, (8 - (buffer.length % 8)) % 8);

    const bytes = buffer.toBytes();
    const out = new Uint8Array(capacity);
    out.set(bytes.subarray(0, capacity));
    for (let i = bytes.length; i < capacity; i += 2) {
        out[i] = 0xec;
        if (i + 1 < capacity) out[i + 1] = 0x11;
    }
    return out;
}

/** Split into blocks, append ECC to each, then interleave as the standard requires. */
function addEccAndInterleave(data: Uint8Array, version: number): Uint8Array {
    const index = version - 1;
    const numBlocks = NUM_BLOCKS[index] ?? 1;
    const eccLength = ECC_CODEWORDS_PER_BLOCK[index] ?? 0;
    const total = rawCodewords(version);
    const numShortBlocks = numBlocks - (total % numBlocks);
    const shortBlockLength = Math.floor(total / numBlocks);

    const divisor = reedSolomonDivisor(eccLength);
    const blocks: Uint8Array[] = [];

    let offset = 0;
    for (let i = 0; i < numBlocks; i++) {
        const dataLength = shortBlockLength - eccLength + (i < numShortBlocks ? 0 : 1);
        const chunk = data.subarray(offset, offset + dataLength);
        offset += dataLength;

        const block = new Uint8Array(shortBlockLength + 1);
        block.set(chunk);
        block.set(reedSolomonRemainder(chunk, divisor), block.length - eccLength);
        blocks.push(block);
    }

    const result = new Uint8Array(total);
    let k = 0;
    for (let i = 0; i < (blocks[0]?.length ?? 0); i++) {
        blocks.forEach((block, j) => {
            // The short blocks have no codeword at the boundary index — skip, do not pad.
            if (i !== shortBlockLength - eccLength || j >= numShortBlocks) {
                result[k] = block[i] ?? 0;
                k++;
            }
        });
    }
    return result;
}

// ───────────────────────────────────────────────────────────── matrix

class Matrix {
    readonly size: number;
    readonly modules: Uint8Array;
    private readonly reserved: Uint8Array;

    constructor(readonly version: number) {
        this.size = version * 4 + 17;
        this.modules = new Uint8Array(this.size * this.size);
        this.reserved = new Uint8Array(this.size * this.size);
    }

    private at(x: number, y: number): number {
        return y * this.size + x;
    }

    get(x: number, y: number): number {
        return this.modules[this.at(x, y)] ?? 0;
    }

    isReserved(x: number, y: number): boolean {
        return (this.reserved[this.at(x, y)] ?? 0) === 1;
    }

    setFunction(x: number, y: number, dark: boolean): void {
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
        this.modules[this.at(x, y)] = dark ? 1 : 0;
        this.reserved[this.at(x, y)] = 1;
    }

    setData(x: number, y: number, dark: boolean): void {
        this.modules[this.at(x, y)] = dark ? 1 : 0;
    }

    toggle(x: number, y: number): void {
        const i = this.at(x, y);
        this.modules[i] = (this.modules[i] ?? 0) ^ 1;
    }
}

function alignmentPositions(version: number): number[] {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const size = version * 4 + 17;
    const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
}

function drawFinder(matrix: Matrix, centreX: number, centreY: number): void {
    for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
            const distance = Math.max(Math.abs(dx), Math.abs(dy));
            matrix.setFunction(centreX + dx, centreY + dy, distance !== 2 && distance !== 4);
        }
    }
}

function drawFunctionPatterns(matrix: Matrix): void {
    const size = matrix.size;

    for (let i = 0; i < size; i++) {
        matrix.setFunction(6, i, i % 2 === 0);
        matrix.setFunction(i, 6, i % 2 === 0);
    }

    drawFinder(matrix, 3, 3);
    drawFinder(matrix, size - 4, 3);
    drawFinder(matrix, 3, size - 4);

    const positions = alignmentPositions(matrix.version);
    const last = positions.length - 1;
    positions.forEach((y, i) => {
        positions.forEach((x, j) => {
            // Alignment patterns never sit on a finder pattern.
            if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    matrix.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        });
    });

    drawFormatBits(matrix, 0);
    drawVersionBits(matrix);
}

function drawFormatBits(matrix: Matrix, mask: number): void {
    // Level M is 0b00; the 10 BCH check bits use the 0x537 generator, XORed with 0x5412.
    const data = (0b00 << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    const size = matrix.size;

    for (let i = 0; i <= 5; i++) matrix.setFunction(8, i, bit(i));
    matrix.setFunction(8, 7, bit(6));
    matrix.setFunction(8, 8, bit(7));
    matrix.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) matrix.setFunction(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) matrix.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) matrix.setFunction(8, size - 15 + i, bit(i));
    matrix.setFunction(8, size - 8, true); // the always-dark module
}

function drawVersionBits(matrix: Matrix): void {
    if (matrix.version < 7) return;
    let remainder = matrix.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (matrix.version << 12) | remainder;

    for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) !== 0;
        const a = matrix.size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        matrix.setFunction(a, b, dark);
        matrix.setFunction(b, a, dark);
    }
}

function drawCodewords(matrix: Matrix, data: Uint8Array): void {
    const size = matrix.size;
    let i = 0;

    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5; // skip the vertical timing column
        for (let vertical = 0; vertical < size; vertical++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vertical : vertical;
                if (!matrix.isReserved(x, y) && i < data.length * 8) {
                    matrix.setData(x, y, ((data[i >>> 3] ?? 0) >>> (7 - (i & 7))) % 2 !== 0);
                    i++;
                }
            }
        }
    }
}

function maskCondition(mask: number, x: number, y: number): boolean {
    switch (mask) {
        case 0:
            return (x + y) % 2 === 0;
        case 1:
            return y % 2 === 0;
        case 2:
            return x % 3 === 0;
        case 3:
            return (x + y) % 3 === 0;
        case 4:
            return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5:
            return ((x * y) % 2) + ((x * y) % 3) === 0;
        case 6:
            return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
        default:
            return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
}

function applyMask(matrix: Matrix, mask: number): void {
    for (let y = 0; y < matrix.size; y++) {
        for (let x = 0; x < matrix.size; x++) {
            if (!matrix.isReserved(x, y) && maskCondition(mask, x, y)) matrix.toggle(x, y);
        }
    }
}

// ───────────────────────────────────────────────────────────── penalty rules (ISO 18004 §8.8.2)

function finderPenaltyCountPatterns(history: number[], size: number): number {
    const n = history[1] ?? 0;
    const core =
        n > 0 &&
        (history[2] ?? 0) === n &&
        (history[3] ?? 0) === n * 3 &&
        (history[4] ?? 0) === n &&
        (history[5] ?? 0) === n;
    void size;
    return (
        (core && (history[0] ?? 0) >= n * 4 && (history[6] ?? 0) >= n ? 1 : 0) +
        (core && (history[6] ?? 0) >= n * 4 && (history[0] ?? 0) >= n ? 1 : 0)
    );
}

function finderPenaltyAddHistory(runLength: number, history: number[], size: number): void {
    const padded = (history[0] ?? 0) === 0 ? runLength + size : runLength;
    history.pop();
    history.unshift(padded);
}

function finderPenaltyTerminate(
    currentDark: boolean,
    currentRun: number,
    history: number[],
    size: number,
): number {
    let run = currentRun;
    if (currentDark) {
        finderPenaltyAddHistory(run, history, size);
        run = 0;
    }
    finderPenaltyAddHistory(run + size, history, size);
    return finderPenaltyCountPatterns(history, size);
}

function penaltyScore(matrix: Matrix): number {
    const size = matrix.size;
    let result = 0;

    for (const vertical of [false, true]) {
        for (let a = 0; a < size; a++) {
            let runDark = false;
            let runLength = 0;
            const history = [0, 0, 0, 0, 0, 0, 0];

            for (let b = 0; b < size; b++) {
                const dark = (vertical ? matrix.get(a, b) : matrix.get(b, a)) === 1;
                if (dark === runDark) {
                    runLength++;
                    if (runLength === 5) result += PENALTY_N1;
                    else if (runLength > 5) result++;
                } else {
                    finderPenaltyAddHistory(runLength, history, size);
                    if (!runDark) result += finderPenaltyCountPatterns(history, size) * PENALTY_N3;
                    runDark = dark;
                    runLength = 1;
                }
            }
            result += finderPenaltyTerminate(runDark, runLength, history, size) * PENALTY_N3;
        }
    }

    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const colour = matrix.get(x, y);
            if (
                colour === matrix.get(x + 1, y) &&
                colour === matrix.get(x, y + 1) &&
                colour === matrix.get(x + 1, y + 1)
            ) {
                result += PENALTY_N2;
            }
        }
    }

    let dark = 0;
    for (const module of matrix.modules) dark += module;
    const total = size * size;
    const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + deviation * PENALTY_N4;
}

// ───────────────────────────────────────────────────────────── public API

/** Encode `text` as a QR matrix (byte mode, level M). Throws `QrTooLongError` past 216 bytes. */
export function encodeQr(text: string): QrMatrix {
    const payload = new TextEncoder().encode(text);
    const version = chooseVersion(payload.length);
    const codewords = addEccAndInterleave(buildDataCodewords(payload, version), version);

    let best: Matrix | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let mask = 0; mask < 8; mask++) {
        const matrix = new Matrix(version);
        drawFunctionPatterns(matrix);
        drawCodewords(matrix, codewords);
        drawFormatBits(matrix, mask);
        applyMask(matrix, mask);

        const score = penaltyScore(matrix);
        if (score < bestScore) {
            bestScore = score;
            best = matrix;
        }
    }

    // `best` is assigned on the first iteration; the guard is for the type system, not reality.
    const chosen = best ?? new Matrix(version);
    return { size: chosen.size, modules: chosen.modules, version: chosen.version };
}

/**
 * The matrix as one SVG `<path>` `d` attribute — one path for the whole symbol keeps the DOM at
 * a single node instead of ~1 500 `<rect>`s, which matters when a page renders forty table QRs.
 */
export function qrPath(matrix: QrMatrix, moduleSize = 1): string {
    const parts: string[] = [];
    for (let y = 0; y < matrix.size; y++) {
        for (let x = 0; x < matrix.size; x++) {
            if ((matrix.modules[y * matrix.size + x] ?? 0) === 1) {
                parts.push(`M${x * moduleSize} ${y * moduleSize}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
            }
        }
    }
    return parts.join('');
}
