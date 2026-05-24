import assert from 'node:assert/strict';
import {
    assembleChunks,
    createFileTransfer,
    createTextTransfer,
    crc32Hex,
    encodeString,
    findMissingIndexes,
    parseBlinkBridgeFrame
} from '../wwwroot/ts/protocol';

const text = 'BlinkBridge text payload';
const textTransfer = createTextTransfer(text);
const parsedText = parseBlinkBridgeFrame(textTransfer.frame);
assert.equal(parsedText?.kind, 'text');
assert.equal(parsedText.kind === 'text' ? parsedText.text : '', text);

const bytes = new Uint8Array(3073);
for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (i * 17) & 0xff;
}

const fileTransfer = createFileTransfer(bytes, 'pipe|safe name.bin', { chunkSize: 700 });
const header = parseBlinkBridgeFrame(fileTransfer.frames[0]);
assert.equal(header?.kind, 'header');
assert.equal(header?.filename, 'pipe|safe name.bin');
assert.equal(header?.count, 5);

const chunks = new Map<number, Uint8Array>();
for (const frame of fileTransfer.frames.slice(1, -1)) {
    const parsed = parseBlinkBridgeFrame(frame);
    assert.equal(parsed?.kind, 'data');
    if (parsed?.kind === 'data') chunks.set(parsed.index, parsed.data);
}

assert.deepEqual(findMissingIndexes(chunks, fileTransfer.dataFrameCount), []);
const assembled = assembleChunks(chunks, fileTransfer.dataFrameCount);
assert.ok(assembled);
assert.equal(assembled.length, bytes.length);
assert.equal(crc32Hex(assembled), crc32Hex(bytes));

const missing = new Map(chunks);
missing.delete(3);
assert.deepEqual(findMissingIndexes(missing, fileTransfer.dataFrameCount), [3]);
assert.equal(assembleChunks(missing, fileTransfer.dataFrameCount), null);

const badText = textTransfer.frame.replace(textTransfer.crcHex, '00000000');
assert.equal(parseBlinkBridgeFrame(badText), null);

const footer = parseBlinkBridgeFrame(fileTransfer.frames[fileTransfer.frames.length - 1]);
assert.equal(footer?.kind, 'footer');
assert.equal(footer?.size, bytes.length);
assert.equal(footer?.crcHex, crc32Hex(bytes));

assert.equal(crc32Hex(encodeString('123456789')), 'CBF43926');
