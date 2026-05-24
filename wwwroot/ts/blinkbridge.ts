import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';
import {
    assembleChunks,
    base64UrlToBytes,
    createFileTransfer,
    createTextTransfer,
    crc32Hex,
    decodeString,
    findMissingIndexes,
    formatBytes,
    FRAME_INTERVAL_MS,
    parseChunkFrame,
    parseHeaderUrl,
    type PreparedTransfer,
    type QrEcc,
    type TransferHeader
} from './protocol';

type RawQrMatrix = Array<Array<boolean | number>>;
type Mode = 'send' | 'receive';
type PayloadKind = 'text' | 'file';

interface TransferFrame {
    payload: string;
    label: string;
    detail: string;
    kind: string;
    ecc: QrEcc;
}

interface NativeBarcodeResult {
    rawValue?: string;
}

interface NativeBarcodeDetector {
    detect(source: CanvasImageSource): Promise<NativeBarcodeResult[]>;
}

declare global {
    interface Window {
        BarcodeDetector?: new (options?: { formats?: string[] }) => NativeBarcodeDetector;
    }
}

function must<T extends Element>(root: ParentNode, selector: string, ctor: { new(): T }): T {
    const el = root.querySelector(selector);
    if (!(el instanceof ctor)) {
        throw new Error(`LocalDrop missing element: ${selector}`);
    }
    return el;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

class LocalDropApp {
    private readonly root: HTMLElement;
    private readonly modeToggle: HTMLInputElement;
    private readonly contentToggle: HTMLButtonElement;
    private readonly contentToggleIcon: HTMLImageElement;
    private readonly contentToggleLabel: HTMLElement;
    private readonly sendPanel: HTMLElement;
    private readonly receivePanel: HTMLElement;
    private readonly textField: HTMLElement;
    private readonly fileField: HTMLElement;
    private readonly textInput: HTMLTextAreaElement;
    private readonly fileInput: HTMLInputElement;
    private readonly fileMeta: HTMLElement;
    private readonly dropzone: HTMLElement;
    private readonly qrStage: HTMLElement;
    private readonly qrCanvas: HTMLCanvasElement;
    private readonly frameLabel: HTMLElement;
    private readonly frameKind: HTMLElement;
    private readonly transferSize: HTMLElement;
    private readonly prevBtn: HTMLButtonElement;
    private readonly playBtn: HTMLButtonElement;
    private readonly nextBtn: HTMLButtonElement;
    private readonly runtimeStatus: HTMLElement;
    private readonly video: HTMLVideoElement;
    private readonly scanCanvas: HTMLCanvasElement;
    private readonly startCameraBtn: HTMLButtonElement;
    private readonly stopCameraBtn: HTMLButtonElement;
    private readonly receiveTransfer: HTMLElement;
    private readonly receiveProgress: HTMLElement;
    private readonly receiveStatus: HTMLElement;
    private readonly resultPanel: HTMLElement;
    private readonly resultText: HTMLTextAreaElement;
    private readonly downloadLink: HTMLAnchorElement;
    private readonly copyBtn: HTMLButtonElement;
    private readonly resetReceiverBtn: HTMLButtonElement;

    private mode: Mode = 'send';
    private payloadKind: PayloadKind = 'text';
    private selectedFile: File | null = null;
    private frames: TransferFrame[] = [];
    private frameIndex = 0;
    private playTimer = 0;
    private isPlaying = false;
    private prepareSequence = 0;
    private textInputTimer = 0;
    private scanStream: MediaStream | null = null;
    private scanActive = false;
    private scanBusy = false;
    private nativeDetector: NativeBarcodeDetector | null = null;
    private lastRawScan = '';
    private objectUrl: string | null = null;
    private receiveHeader: TransferHeader | null = null;
    private receiveKey: CryptoKey | null = null;
    private readonly receiveChunks = new Map<number, Uint8Array>();

    constructor(root: HTMLElement) {
        this.root = root;
        this.modeToggle = must(root, '[data-bb-mode-toggle]', HTMLInputElement);
        this.contentToggle = must(root, '[data-bb-content-toggle]', HTMLButtonElement);
        this.contentToggleIcon = must(root, '[data-bb-content-toggle-icon]', HTMLImageElement);
        this.contentToggleLabel = must(root, '[data-bb-content-toggle-label]', HTMLElement);
        this.sendPanel = must(root, '[data-bb-send-panel]', HTMLElement);
        this.receivePanel = must(root, '[data-bb-receive-panel]', HTMLElement);
        this.textField = must(root, '[data-bb-text-field]', HTMLElement);
        this.fileField = must(root, '[data-bb-file-field]', HTMLElement);
        this.textInput = must(root, '[data-bb-text-input]', HTMLTextAreaElement);
        this.fileInput = must(root, '[data-bb-file-input]', HTMLInputElement);
        this.fileMeta = must(root, '[data-bb-file-meta]', HTMLElement);
        this.dropzone = must(root, '[data-bb-dropzone]', HTMLElement);
        this.qrStage = must(root, '[data-bb-qr-stage]', HTMLElement);
        this.qrCanvas = must(root, '[data-bb-qr-canvas]', HTMLCanvasElement);
        this.frameLabel = must(root, '[data-bb-frame-label]', HTMLElement);
        this.frameKind = must(root, '[data-bb-frame-kind]', HTMLElement);
        this.transferSize = must(root, '[data-bb-transfer-size]', HTMLElement);
        this.prevBtn = must(root, '[data-bb-prev]', HTMLButtonElement);
        this.playBtn = must(root, '[data-bb-play]', HTMLButtonElement);
        this.nextBtn = must(root, '[data-bb-next]', HTMLButtonElement);
        this.runtimeStatus = must(root, '[data-bb-runtime-status]', HTMLElement);
        this.video = must(root, '[data-bb-video]', HTMLVideoElement);
        this.scanCanvas = must(root, '[data-bb-scan-canvas]', HTMLCanvasElement);
        this.startCameraBtn = must(root, '[data-bb-start-camera]', HTMLButtonElement);
        this.stopCameraBtn = must(root, '[data-bb-stop-camera]', HTMLButtonElement);
        this.receiveTransfer = must(root, '[data-bb-receive-transfer]', HTMLElement);
        this.receiveProgress = must(root, '[data-bb-receive-progress]', HTMLElement);
        this.receiveStatus = must(root, '[data-bb-receive-status]', HTMLElement);
        this.resultPanel = must(root, '[data-bb-result]', HTMLElement);
        this.resultText = must(root, '[data-bb-result-text]', HTMLTextAreaElement);
        this.downloadLink = must(root, '[data-bb-download]', HTMLAnchorElement);
        this.copyBtn = must(root, '[data-bb-copy]', HTMLButtonElement);
        this.resetReceiverBtn = must(root, '[data-bb-reset-receiver]', HTMLButtonElement);
    }

    boot(): void {
        this.bindEvents();
        this.syncMode();
        this.syncKind();
        this.runtimeStatus.textContent = 'Offline client';
        void this.loadHeaderFromCurrentUrl();
    }

    private bindEvents(): void {
        this.modeToggle.addEventListener('change', () => {
            this.mode = this.modeToggle.checked ? 'receive' : 'send';
            this.syncMode();
        });

        this.contentToggle.addEventListener('click', () => {
            this.payloadKind = this.payloadKind === 'text' ? 'file' : 'text';
            this.syncKind();
            if (this.payloadKind === 'text') {
                this.textInput.focus();
                void this.prepareTransfer();
            }
        });

        this.textInput.addEventListener('focus', () => void this.prepareTransfer());
        this.textInput.addEventListener('input', () => {
            window.clearTimeout(this.textInputTimer);
            this.textInputTimer = window.setTimeout(() => void this.prepareTransfer(), 250);
        });

        this.fileInput.addEventListener('change', () => {
            this.setSelectedFile(this.fileInput.files?.[0] ?? null);
        });

        this.dropzone.addEventListener('dragover', (event) => {
            event.preventDefault();
            this.dropzone.classList.add('bb-dropzone--active');
        });

        this.dropzone.addEventListener('dragleave', () => {
            this.dropzone.classList.remove('bb-dropzone--active');
        });

        this.dropzone.addEventListener('drop', (event) => {
            event.preventDefault();
            this.dropzone.classList.remove('bb-dropzone--active');
            this.setSelectedFile(event.dataTransfer?.files?.[0] ?? null);
        });

        this.prevBtn.addEventListener('click', () => this.showFrame(this.frameIndex - 1, false));
        this.nextBtn.addEventListener('click', () => this.showFrame(this.frameIndex + 1, false));
        this.playBtn.addEventListener('click', () => this.togglePlayback());

        this.startCameraBtn.addEventListener('click', () => void this.startCamera());
        this.stopCameraBtn.addEventListener('click', () => this.stopCamera());
        this.resetReceiverBtn.addEventListener('click', () => this.resetReceiver());
        this.copyBtn.addEventListener('click', () => void this.copyTextResult());
    }

    private syncMode(): void {
        this.sendPanel.hidden = this.mode !== 'send';
        this.receivePanel.hidden = this.mode !== 'receive';

        if (this.mode === 'receive') {
            this.stopPlayback();
        } else {
            this.stopCamera();
        }
    }

    private syncKind(): void {
        this.textField.hidden = this.payloadKind !== 'text';
        this.fileField.hidden = this.payloadKind !== 'file';
        const isFile = this.payloadKind === 'file';
        this.contentToggle.setAttribute('aria-label', isFile ? 'Switch to text entry' : 'Switch to file upload');
        this.contentToggleLabel.textContent = isFile ? 'Text' : 'Upload...';
        this.contentToggleIcon.src = isFile
            ? '/apps/indium/assets/svg/cursor-text.svg'
            : '/apps/indium/assets/svg/paper-clip.svg';
        this.resetPreparedTransfer();
    }

    private setSelectedFile(file: File | null): void {
        this.selectedFile = file;
        if (!file) {
            this.fileMeta.textContent = 'No file selected';
            this.resetPreparedTransfer();
            return;
        }

        this.fileMeta.textContent = `${file.name} - ${formatBytes(file.size)}`;
        void this.prepareTransfer();
    }

    private resetPreparedTransfer(): void {
        this.stopPlayback();
        this.frames = [];
        this.frameIndex = 0;
        this.qrStage.hidden = true;
    }

    private async prepareTransfer(): Promise<void> {
        const sequence = ++this.prepareSequence;

        try {
            let transfer: PreparedTransfer;
            if (this.payloadKind === 'text') {
                transfer = await createTextTransfer(this.textInput.value, this.receiveUrl());
            } else {
                if (!this.selectedFile) {
                    this.runtimeStatus.textContent = 'File required';
                    this.resetPreparedTransfer();
                    return;
                }

                const bytes = new Uint8Array(await this.selectedFile.arrayBuffer());
                transfer = await createFileTransfer(bytes, this.selectedFile.name, this.receiveUrl());
            }

            if (sequence !== this.prepareSequence) return;

            this.frames = transfer.frames.map((payload, index) => ({
                payload,
                label: `Frame ${index + 1} of ${transfer.frames.length}`,
                detail: this.describeFrame(index, transfer),
                kind: index === 0 ? 'Header URL' : `Chunk ${index}`,
                ecc: transfer.ecc
            }));
            this.qrStage.hidden = false;
            this.showFrame(0, false);
            this.runtimeStatus.textContent = transfer.header.kind === 'text'
                ? `Text ready - ${formatBytes(transfer.byteSize)}`
                : `File ready - ${formatBytes(transfer.byteSize)}`;
        } catch (error) {
            console.error('[LocalDrop] Prepare failed', error);
            this.runtimeStatus.textContent = 'Prepare failed';
        }
    }

    private describeFrame(index: number, transfer: PreparedTransfer): string {
        if (index === 0) {
            return transfer.header.kind === 'text'
                ? 'Scan with another device to open the text.'
                : 'Scan with another device to begin transfer.';
        }

        return `Chunk ${index} of ${transfer.header.count} - ${formatBytes(transfer.header.chunkSize)} target`;
    }

    private showFrame(nextIndex: number, play: boolean): void {
        if (!this.frames.length) return;

        this.frameIndex = clamp(nextIndex, 0, this.frames.length - 1);
        const frame = this.frames[this.frameIndex];
        this.renderQr(frame.payload, frame.ecc);
        this.frameLabel.textContent = frame.label;
        this.frameKind.textContent = frame.kind;
        this.transferSize.textContent = frame.detail;
        this.prevBtn.disabled = this.frameIndex === 0;
        this.nextBtn.disabled = this.frameIndex === this.frames.length - 1;
        this.isPlaying = play && this.frames.length > 1 && this.frameIndex < this.frames.length - 1;
        this.playBtn.disabled = this.frames.length <= 1;
        this.playBtn.textContent = this.isPlaying ? 'Pause' : 'Begin';

        if (this.isPlaying) {
            this.scheduleNextFrame();
        } else {
            this.stopPlaybackTimer();
        }
    }

    private renderQr(payload: string, ecc: QrEcc): void {
        const matrix = encodeQR(payload, 'raw', {
            ecc,
            encoding: 'byte',
            border: 4
        }) as RawQrMatrix;

        const ctx = this.qrCanvas.getContext('2d');
        if (!ctx) return;

        const size = matrix.length;
        const canvasSize = 720;
        const moduleSize = Math.floor(canvasSize / size);
        const drawSize = moduleSize * size;
        const offset = Math.floor((canvasSize - drawSize) / 2);

        this.qrCanvas.width = canvasSize;
        this.qrCanvas.height = canvasSize;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasSize, canvasSize);
        ctx.fillStyle = '#000000';

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (matrix[y][x]) {
                    ctx.fillRect(offset + x * moduleSize, offset + y * moduleSize, moduleSize, moduleSize);
                }
            }
        }
    }

    private togglePlayback(): void {
        if (!this.frames.length || this.frames.length <= 1) return;

        if (this.isPlaying) {
            this.stopPlayback();
            this.playBtn.textContent = 'Begin';
            return;
        }

        this.showFrame(this.frameIndex === 0 || this.frameIndex === this.frames.length - 1 ? 1 : this.frameIndex, true);
    }

    private scheduleNextFrame(): void {
        this.stopPlaybackTimer();
        if (!this.isPlaying || this.frameIndex >= this.frames.length - 1) return;

        this.playTimer = window.setTimeout(() => {
            const nextIndex = this.frameIndex + 1;
            this.showFrame(nextIndex, nextIndex < this.frames.length - 1);
        }, FRAME_INTERVAL_MS);
    }

    private stopPlayback(): void {
        this.isPlaying = false;
        this.stopPlaybackTimer();
    }

    private stopPlaybackTimer(): void {
        if (this.playTimer) {
            window.clearTimeout(this.playTimer);
            this.playTimer = 0;
        }
    }

    private async startCamera(): Promise<void> {
        if (this.scanActive) return;

        try {
            if (!this.receiveHeader) {
                this.resetReceiver();
            }

            this.scanStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });
            this.video.srcObject = this.scanStream;
            await this.video.play();

            if (window.BarcodeDetector) {
                try {
                    this.nativeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
                } catch {
                    this.nativeDetector = null;
                }
            }

            this.scanActive = true;
            this.startCameraBtn.disabled = true;
            this.stopCameraBtn.disabled = false;
            this.receiveStatus.textContent = this.receiveHeader ? 'Scanning chunks.' : 'Scanning for header.';
            this.runtimeStatus.textContent = this.nativeDetector ? 'Native scanner' : 'Canvas scanner';
            this.queueScan();
        } catch (error) {
            console.error('[LocalDrop] Camera failed', error);
            this.receiveStatus.textContent = 'Camera unavailable. Use HTTPS or allow camera access.';
            this.stopCamera();
        }
    }

    private stopCamera(): void {
        this.scanActive = false;
        this.scanBusy = false;
        this.startCameraBtn.disabled = false;
        this.stopCameraBtn.disabled = true;

        if (this.scanStream) {
            for (const track of this.scanStream.getTracks()) {
                track.stop();
            }
            this.scanStream = null;
        }

        this.video.srcObject = null;
    }

    private queueScan(): void {
        if (!this.scanActive) return;

        const run = () => {
            if (!this.scanActive || this.scanBusy) {
                this.queueScan();
                return;
            }

            this.scanBusy = true;
            void this.scanOnce()
                .catch((error) => console.debug('[LocalDrop] Scan miss', error))
                .finally(() => {
                    this.scanBusy = false;
                    this.queueScan();
                });
        };

        if (this.video.requestVideoFrameCallback) {
            this.video.requestVideoFrameCallback(run);
        } else {
            window.requestAnimationFrame(run);
        }
    }

    private async scanOnce(): Promise<void> {
        if (!this.video.videoWidth || !this.video.videoHeight) return;

        let raw = '';
        if (this.nativeDetector) {
            const results = await this.nativeDetector.detect(this.video);
            raw = results[0]?.rawValue ?? '';
        }

        if (!raw) {
            raw = this.scanViaCanvas();
        }

        if (!raw || raw === this.lastRawScan) return;

        this.lastRawScan = raw;
        await this.handleRawFrame(raw);
    }

    private scanViaCanvas(): string {
        const sourceSize = Math.min(this.video.videoWidth, this.video.videoHeight);
        const sx = Math.floor((this.video.videoWidth - sourceSize) / 2);
        const sy = Math.floor((this.video.videoHeight - sourceSize) / 2);
        const targetSize = 720;
        const ctx = this.scanCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return '';

        this.scanCanvas.width = targetSize;
        this.scanCanvas.height = targetSize;
        ctx.drawImage(this.video, sx, sy, sourceSize, sourceSize, 0, 0, targetSize, targetSize);

        const image = ctx.getImageData(0, 0, targetSize, targetSize);
        try {
            return decodeQR({
                width: image.width,
                height: image.height,
                data: image.data
            });
        } catch {
            return '';
        }
    }

    private async handleRawFrame(raw: string): Promise<void> {
        const receivedHeader = await parseHeaderUrl(raw);
        if (receivedHeader) {
            this.applyReceivedHeader(receivedHeader.header, receivedHeader.key);
            return;
        }

        if (!this.receiveHeader || !this.receiveKey) {
            this.receiveStatus.textContent = 'Scan the header URL first.';
            return;
        }

        const chunk = await parseChunkFrame(raw, this.receiveKey);
        if (!chunk) {
            this.receiveStatus.textContent = 'Unsupported QR.';
            return;
        }

        if (chunk.index > this.receiveHeader.count) {
            this.receiveStatus.textContent = `Unexpected chunk ${chunk.index}.`;
            return;
        }

        this.receiveChunks.set(chunk.index, chunk.data);
        this.receiveStatus.textContent = `Chunk ${chunk.index} received.`;
        this.syncReceiveProgress();
        this.tryCompleteFile();
    }

    private applyReceivedHeader(header: TransferHeader, key: CryptoKey): void {
        const isNewTransfer =
            !this.receiveHeader
            || this.receiveHeader.crcHex !== header.crcHex
            || this.receiveHeader.size !== header.size
            || this.receiveHeader.filename !== header.filename
            || this.receiveHeader.kind !== header.kind;

        if (isNewTransfer) {
            this.resetReceiver(false);
            this.receiveHeader = header;
            this.receiveKey = key;
        }

        if (header.kind === 'text') {
            const bytes = base64UrlToBytes(header.textPayload ?? '');
            if (bytes.length !== header.size || crc32Hex(bytes) !== header.crcHex) {
                this.receiveStatus.textContent = 'Text validation failed.';
                return;
            }

            this.showTextResult(decodeString(bytes), header.size, header.crcHex);
            return;
        }

        this.receiveStatus.textContent = `Header received for ${header.filename}.`;
        this.syncReceiveProgress();
    }

    private syncReceiveProgress(): void {
        if (!this.receiveHeader) {
            this.receiveTransfer.textContent = 'Waiting';
            this.receiveProgress.textContent = '0 / 0';
            return;
        }

        const missing = findMissingIndexes(this.receiveChunks, this.receiveHeader.count);
        const label = this.receiveHeader.kind === 'file'
            ? `${this.receiveHeader.filename} - ${formatBytes(this.receiveHeader.size)}`
            : `Text - ${formatBytes(this.receiveHeader.size)}`;
        this.receiveTransfer.textContent = label;
        this.receiveProgress.textContent = `${this.receiveChunks.size} / ${this.receiveHeader.count}`;

        if (missing.length && this.receiveChunks.size > 0) {
            this.receiveStatus.textContent = `Missing chunks: ${missing.join(', ')}`;
        }
    }

    private tryCompleteFile(): void {
        if (!this.receiveHeader || this.receiveHeader.kind !== 'file') return;

        const assembled = assembleChunks(this.receiveChunks, this.receiveHeader.count);
        if (!assembled) return;

        if (assembled.length !== this.receiveHeader.size) {
            this.receiveStatus.textContent = `Size mismatch: ${assembled.length} of ${this.receiveHeader.size}.`;
            return;
        }

        const actualCrc = crc32Hex(assembled);
        if (actualCrc !== this.receiveHeader.crcHex) {
            this.receiveStatus.textContent = `CRC mismatch: ${actualCrc} expected ${this.receiveHeader.crcHex}.`;
            return;
        }

        this.showFileResult(assembled, this.receiveHeader.filename ?? 'blinkbridge-file', actualCrc);
    }

    private showTextResult(text: string, size: number, crcHex: string): void {
        this.clearObjectUrl();
        this.resultPanel.hidden = false;
        this.resultText.hidden = false;
        this.resultText.value = text;
        this.copyBtn.hidden = false;
        this.downloadLink.hidden = true;
        this.receiveTransfer.textContent = `Text - ${formatBytes(size)}`;
        this.receiveProgress.textContent = '1 / 1';
        this.receiveStatus.textContent = `Text validated. CRC ${crcHex}.`;
    }

    private showFileResult(bytes: Uint8Array, filename: string, crcHex: string): void {
        this.clearObjectUrl();
        const fileBytes = new Uint8Array(bytes);
        const blob = new Blob([fileBytes.buffer]);
        this.objectUrl = URL.createObjectURL(blob);
        this.downloadLink.href = this.objectUrl;
        this.downloadLink.download = filename;
        this.downloadLink.hidden = false;
        this.copyBtn.hidden = true;
        this.resultText.hidden = true;
        this.resultPanel.hidden = false;
        this.receiveStatus.textContent = `File validated. CRC ${crcHex}.`;
    }

    private async copyTextResult(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.resultText.value);
            this.receiveStatus.textContent = 'Text copied.';
        } catch {
            this.resultText.select();
            this.receiveStatus.textContent = 'Text selected.';
        }
    }

    private resetReceiver(clearStatus = true): void {
        this.clearObjectUrl();
        this.receiveHeader = null;
        this.receiveKey = null;
        this.receiveChunks.clear();
        this.lastRawScan = '';
        this.resultPanel.hidden = true;
        this.resultText.value = '';
        this.downloadLink.hidden = true;
        this.copyBtn.hidden = true;
        this.resultText.hidden = true;
        this.receiveTransfer.textContent = 'Waiting';
        this.receiveProgress.textContent = '0 / 0';
        if (clearStatus) this.receiveStatus.textContent = this.scanActive ? 'Scanning.' : 'Camera idle.';
    }

    private async loadHeaderFromCurrentUrl(): Promise<void> {
        const receivedHeader = await parseHeaderUrl(window.location.href);
        if (!receivedHeader) return;

        this.mode = 'receive';
        this.modeToggle.checked = true;
        this.syncMode();
        this.applyReceivedHeader(receivedHeader.header, receivedHeader.key);
    }

    private receiveUrl(): string {
        return new URL('/blinkbridge', window.location.origin).toString();
    }

    private clearObjectUrl(): void {
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}

function boot(): void {
    const root = document.querySelector<HTMLElement>('[data-bb-app]');
    if (!root) return;

    new LocalDropApp(root).boot();
    document.body.dataset.initialState = 'ready';
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
