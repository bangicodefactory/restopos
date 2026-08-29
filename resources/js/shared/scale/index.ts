export { FakeScaleTransport } from './fake';
export { parseScaleFrame, splitFrames } from './protocol';
export { ScaleReader, type ScaleReaderOptions, type ScaleState, type ScaleStatus } from './reader';
export {
    toKilograms,
    WeightSource,
    type ScaleReading,
    type ScaleTransport,
    type ScaleTransportKind,
    type WeightUnit,
} from './types';
export { WebSerialScaleTransport, type WebSerialScaleOptions } from './web-serial';
export { resolveScaleTransport, type ScaleTransportMap } from './resolve';
