import { crc32 } from '@foxglove/crc';

export type QrEcc = 'low' | 'medium';

export interface TextTransfer {
    frame: string;
    byteSize: number;
    crcHex: string;
}

export interface FileTransfer {
    frames: string[];
    dataFrameCount: number;
    filename: string;
    byteSize: number;
    crcHex: string;
    chunkSize: number;
    ecc: QrEcc;
}

export type ParsedFrame =
    | { kind: 'text'; size: number; crcHex: string; data: Uint8Array; text: string }
    | { kind: 'header'; count: number; filename: string; size: number; crcHex: string }
    | { kind: 'data'; index: number; data: Uint8Array }
    | { kind: 'footer'; filename: string; size: number; crcHex: string };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BYTE_STRING_CHUNK = 0x8000;

export const DEFAULT_CHUNK_SIZE = 1200;
export const FAST_CHUNK_SIZE = 1800;

export function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += BYTE_STRING_CHUNK) {
        const chunk = bytes.subarray(offset, offset + BYTE_STRING_CHUNK);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

export function encodeString(value: string): Uint8Array {
    return textEncoder.encode(value);
}

export function decodeString(bytes: Uint8Array): string {
    return textDecoder.decode(bytes);
}

export function crc32Hex(bytes: Uint8Array): string {
    return crc32(bytes).toString(16).padStart(8, '0').toUpperCase();
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
}

export function createTextTransfer(text: string): TextTransfer {
    const bytes = encodeString(text);
    const crcHex = crc32Hex(bytes);
    const payload = bytesToBase64Url(bytes);

    return {
        frame: `BBT|${bytes.length}|${crcHex}|${payload}`,
        byteSize: bytes.length,
        crcHex
    };
}

export function createFileTransfer(
    fileBytes: Uint8Array,
    filename: string,
    options: { fast?: boolean; chunkSize?: number } = {}
): FileTransfer {
    const safeFilename = filename.trim() || 'blinkbridge-file';
    const chunkSize = options.chunkSize ?? (options.fast ? FAST_CHUNK_SIZE : DEFAULT_CHUNK_SIZE);
    const ecc: QrEcc = options.fast ? 'low' : 'medium';
    const crcHex = crc32Hex(fileBytes);
    const filenamePayload = bytesToBase64Url(encodeString(safeFilename));
    const dataFrameCount = Math.max(1, Math.ceil(fileBytes.length / chunkSize));
    const frames: string[] = [
        `BBH|${dataFrameCount}|${filenamePayload}|${fileBytes.length}|${crcHex}`
    ];

    for (let index = 0; index < dataFrameCount; index++) {
        const start = index * chunkSize;
        const chunk = fileBytes.subarray(start, Math.min(fileBytes.length, start + chunkSize));
        frames.push(`BBD|${index + 1}|${bytesToBase64Url(chunk)}`);
    }

    frames.push(`BBF|${filenamePayload}|${fileBytes.length}|${crcHex}`);

    return {
        frames,
        dataFrameCount,
        filename: safeFilename,
        byteSize: fileBytes.length,
        crcHex,
        chunkSize,
        ecc
    };
}

export function parseBlinkBridgeFrame(raw: string): ParsedFrame | null {
    const value = raw.trim();
    if (!value.startsWith('BB')) return null;

    const parts = value.split('|');
    const type = parts[0];

    if (type === 'BBT' && parts.length === 4) {
        const size = parsePositiveInt(parts[1]);
        const crcHex = parseCrc(parts[2]);
        if (size === null || crcHex === null) return null;

        const data = base64UrlToBytes(parts[3]);
        if (data.length !== size || crc32Hex(data) !== crcHex) {
            return null;
        }

        return {
            kind: 'text',
            size,
            crcHex,
            data,
            text: decodeString(data)
        };
    }

    if (type === 'BBH' && parts.length === 5) {
        const count = parsePositiveInt(parts[1]);
        const filename = decodeString(base64UrlToBytes(parts[2]));
        const size = parseNonNegativeInt(parts[3]);
        const crcHex = parseCrc(parts[4]);
        if (count === null || size === null || crcHex === null || !filename.trim()) return null;

        return { kind: 'header', count, filename, size, crcHex };
    }

    if (type === 'BBD' && parts.length === 3) {
        const index = parsePositiveInt(parts[1]);
        if (index === null) return null;

        return {
            kind: 'data',
            index,
            data: base64UrlToBytes(parts[2])
        };
    }

    if (type === 'BBF' && parts.length === 4) {
        const filename = decodeString(base64UrlToBytes(parts[1]));
        const size = parseNonNegativeInt(parts[2]);
        const crcHex = parseCrc(parts[3]);
        if (size === null || crcHex === null || !filename.trim()) return null;

        return { kind: 'footer', filename, size, crcHex };
    }

    return null;
}

export function findMissingIndexes(chunks: Map<number, Uint8Array>, count: number): number[] {
    const missing: number[] = [];
    for (let i = 1; i <= count; i++) {
        if (!chunks.has(i)) missing.push(i);
    }
    return missing;
}

export function assembleChunks(chunks: Map<number, Uint8Array>, count: number): Uint8Array | null {
    const missing = findMissingIndexes(chunks, count);
    if (missing.length) return null;

    let size = 0;
    for (let i = 1; i <= count; i++) {
        size += chunks.get(i)!.length;
    }

    const output = new Uint8Array(size);
    let offset = 0;
    for (let i = 1; i <= count; i++) {
        const chunk = chunks.get(i)!;
        output.set(chunk, offset);
        offset += chunk.length;
    }

    return output;
}

function parsePositiveInt(value: string): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value: string): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseCrc(value: string): string | null {
    const normalized = value.trim().toUpperCase();
    return /^[0-9A-F]{8}$/.test(normalized) ? normalized : null;
}
