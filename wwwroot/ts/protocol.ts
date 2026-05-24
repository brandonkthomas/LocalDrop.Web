import { crc32 } from '@foxglove/crc';

export type QrEcc = 'low' | 'medium';

export interface TransferHeader {
    v: 1;
    kind: 'text' | 'file';
    size: number;
    crcHex: string;
    count: number;
    chunkSize: number;
    filename?: string;
    textPayload?: string;
}

export interface PreparedTransfer {
    frames: string[];
    header: TransferHeader;
    byteSize: number;
    crcHex: string;
    ecc: QrEcc;
}

export interface ReceivedHeader {
    header: TransferHeader;
    key: CryptoKey;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BYTE_STRING_CHUNK = 0x8000;
export const FAST_CHUNK_SIZE = 1800;
export const FRAME_INTERVAL_MS = 600;

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

export async function createTextTransfer(text: string, receiveUrl: string): Promise<PreparedTransfer> {
    const bytes = encodeString(text);
    const crcHex = crc32Hex(bytes);
    const key = await createKey();
    const header: TransferHeader = {
        v: 1,
        kind: 'text',
        size: bytes.length,
        crcHex,
        count: 0,
        chunkSize: 0,
        textPayload: bytesToBase64Url(bytes)
    };

    return {
        frames: [await createHeaderUrl(header, key, receiveUrl)],
        header,
        byteSize: bytes.length,
        crcHex,
        ecc: 'low'
    };
}

export async function createFileTransfer(
    fileBytes: Uint8Array,
    filename: string,
    receiveUrl: string,
    chunkSize = FAST_CHUNK_SIZE
): Promise<PreparedTransfer> {
    const safeFilename = filename.trim() || 'localdrop-file';
    const crcHex = crc32Hex(fileBytes);
    const count = Math.max(1, Math.ceil(fileBytes.length / chunkSize));
    const key = await createKey();
    const header: TransferHeader = {
        v: 1,
        kind: 'file',
        filename: safeFilename,
        size: fileBytes.length,
        crcHex,
        count,
        chunkSize
    };
    const frames = [await createHeaderUrl(header, key, receiveUrl)];

    for (let index = 0; index < count; index++) {
        const start = index * chunkSize;
        const chunk = fileBytes.subarray(start, Math.min(fileBytes.length, start + chunkSize));
        frames.push(await createChunkFrame(index + 1, chunk, key));
    }

    return {
        frames,
        header,
        byteSize: fileBytes.length,
        crcHex,
        ecc: 'low'
    };
}

export async function parseHeaderUrl(raw: string): Promise<ReceivedHeader | null> {
    let url: URL;
    try {
        url = new URL(raw, globalThis.location?.origin ?? 'http://localhost');
    } catch {
        return null;
    }

    if (url.searchParams.get('mode') !== 'receive') return null;

    const encryptedHeader = url.searchParams.get('h');
    const exportedKey = url.searchParams.get('k');
    if (!encryptedHeader || !exportedKey) return null;

    try {
        const key = await importKey(exportedKey);
        const header = JSON.parse(decodeString(await decryptBytes(encryptedHeader, key))) as TransferHeader;
        return isValidHeader(header) ? { header, key } : null;
    } catch {
        return null;
    }
}

export async function parseChunkFrame(raw: string, key: CryptoKey): Promise<{ index: number; data: Uint8Array } | null> {
    const match = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(raw.trim());
    if (!match) return null;

    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 1) return null;

    try {
        return {
            index,
            data: await decryptBytes(match[2], key)
        };
    } catch {
        return null;
    }
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

async function createHeaderUrl(header: TransferHeader, key: CryptoKey, receiveUrl: string): Promise<string> {
    const url = new URL(receiveUrl);
    url.searchParams.set('mode', 'receive');
    url.searchParams.set('h', await encryptBytes(encodeString(JSON.stringify(header)), key));
    url.searchParams.set('k', await exportKey(key));
    return url.toString();
}

async function createChunkFrame(index: number, chunk: Uint8Array, key: CryptoKey): Promise<string> {
    return `${index}.${await encryptBytes(chunk, key)}`;
}

async function createKey(): Promise<CryptoKey> {
    return globalThis.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
}

async function exportKey(key: CryptoKey): Promise<string> {
    return bytesToBase64Url(new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key)));
}

async function importKey(value: string): Promise<CryptoKey> {
    return globalThis.crypto.subtle.importKey(
        'raw',
        toArrayBuffer(base64UrlToBytes(value)),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptBytes(bytes: Uint8Array, key: CryptoKey): Promise<string> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(bytes)
    ));
    const payload = new Uint8Array(iv.length + encrypted.length);
    payload.set(iv, 0);
    payload.set(encrypted, iv.length);
    return bytesToBase64Url(payload);
}

async function decryptBytes(payload: string, key: CryptoKey): Promise<Uint8Array> {
    const bytes = base64UrlToBytes(payload);
    if (bytes.length <= 12) throw new Error('Encrypted payload missing body.');

    const iv = bytes.subarray(0, 12);
    const encrypted = bytes.subarray(12);
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(encrypted)
    ));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isValidHeader(header: TransferHeader): boolean {
    if (header?.v !== 1) return false;
    if (header.kind !== 'text' && header.kind !== 'file') return false;
    if (!Number.isSafeInteger(header.size) || header.size < 0) return false;
    if (!/^[0-9A-F]{8}$/.test(header.crcHex)) return false;
    if (!Number.isSafeInteger(header.count) || header.count < 0) return false;
    if (!Number.isSafeInteger(header.chunkSize) || header.chunkSize < 0) return false;

    if (header.kind === 'text') {
        return typeof header.textPayload === 'string';
    }

    return Boolean(header.filename?.trim()) && header.count > 0 && header.chunkSize > 0;
}
