import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
    assembleChunks,
    createFileTransfer,
    createTextTransfer,
    crc32Hex,
    encodeString,
    findMissingIndexes,
    MAX_FILE_BYTES,
    MAX_FILE_FRAMES,
    parseChunkFrame,
    parseHeaderUrl
} from '../wwwroot/ts/protocol';

if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

if (!globalThis.btoa) {
    Object.defineProperty(globalThis, 'btoa', {
        value: (value: string) => Buffer.from(value, 'binary').toString('base64')
    });
}

if (!globalThis.atob) {
    Object.defineProperty(globalThis, 'atob', {
        value: (value: string) => Buffer.from(value, 'base64').toString('binary')
    });
}

const receiveUrl = 'https://example.test/localdrop';
const text = 'LocalDrop text payload';
const textTransfer = await createTextTransfer(text, receiveUrl);
assert.equal(textTransfer.frames.length, 1);

const parsedTextHeader = await parseHeaderUrl(textTransfer.frames[0]);
assert.equal(parsedTextHeader?.header.kind, 'text');
assert.equal(parsedTextHeader?.header.size, encodeString(text).length);
assert.equal(parsedTextHeader?.header.crcHex, crc32Hex(encodeString(text)));

const bytes = new Uint8Array(3073);
for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (i * 17) & 0xff;
}

const fileTransfer = await createFileTransfer(bytes, 'pipe|safe name.bin', receiveUrl, 700);
const repeatedFileTransfer = await createFileTransfer(bytes, 'pipe|safe name.bin', receiveUrl, 700);
assert.notEqual(fileTransfer.header.transferId, repeatedFileTransfer.header.transferId);
const parsedFileHeader = await parseHeaderUrl(fileTransfer.frames[0]);
assert.equal(parsedFileHeader?.header.kind, 'file');
assert.equal(typeof parsedFileHeader?.header.transferId, 'string');
assert.equal(parsedFileHeader?.header.filename, 'pipe|safe name.bin');
assert.equal(parsedFileHeader?.header.count, 5);
assert.equal(parsedFileHeader?.header.crcHex, crc32Hex(bytes));

assert.ok(parsedFileHeader);
const chunks = new Map<number, Uint8Array>();
for (const frame of fileTransfer.frames.slice(1)) {
    const parsed = await parseChunkFrame(frame, parsedFileHeader.key);
    assert.ok(parsed);
    chunks.set(parsed.index, parsed.data);
}

assert.deepEqual(findMissingIndexes(chunks, fileTransfer.header.count), []);
const assembled = assembleChunks(chunks, fileTransfer.header.count);
assert.ok(assembled);
assert.equal(assembled.length, bytes.length);
assert.equal(crc32Hex(assembled), crc32Hex(bytes));

const missing = new Map(chunks);
missing.delete(3);
assert.deepEqual(findMissingIndexes(missing, fileTransfer.header.count), [3]);
assert.equal(assembleChunks(missing, fileTransfer.header.count), null);

const tamperedUrl = textTransfer.frames[0].replace(/h=[^&]+/, 'h=broken');
assert.equal(await parseHeaderUrl(tamperedUrl), null);
assert.equal(await parseChunkFrame('3.broken', parsedFileHeader.key), null);
assert.equal(crc32Hex(encodeString('123456789')), 'CBF43926');
assert.equal(assembleChunks(new Map(), MAX_FILE_FRAMES + 1), null);
await assert.rejects(
    () => createFileTransfer(new Uint8Array(MAX_FILE_BYTES + 1), 'too-large.bin', receiveUrl),
    /larger than/
);
