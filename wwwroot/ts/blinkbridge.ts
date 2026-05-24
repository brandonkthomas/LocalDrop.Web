import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';
import {
    assembleChunks,
    createFileTransfer,
    createTextTransfer,
    crc32Hex,
    findMissingIndexes,
    formatBytes,
    parseBlinkBridgeFrame,
    type ParsedFrame,
    type QrEcc
} from './protocol';

type RawQrMatrix = Array<Array<boolean | number>>;
type Mode = 'send' | 'receive';
type PayloadKind = 'text' | 'file';

interface TransferFrame {
    payload: string;
    label: string;
    detail: string;
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
        throw new Error(`BlinkBridge missing element: ${selector}`);
    }
    return el;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
    if (!values.length) return 600;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

class BlinkBridgeApp {
    private readonly root: HTMLElement;
    private readonly modeToggle: HTMLInputElement;
    private readonly kindToggle: HTMLInputElement;
    private readonly sendPanel: HTMLElement;
    private readonly receivePanel: HTMLElement;
    private readonly textField: HTMLElement;
    private readonly fileField: HTMLElement;
    private readonly textInput: HTMLTextAreaElement;
    private readonly fileInput: HTMLInputElement;
    private readonly fileMeta: HTMLElement;
    private readonly dropzone: HTMLElement;
    private readonly prepareBtn: HTMLButtonElement;
    private readonly fastPreset: HTMLInputElement;
    private readonly qrStage: HTMLElement;
    private readonly inputPanel: HTMLElement;
    private readonly qrCanvas: HTMLCanvasElement;
    private readonly frameLabel: HTMLElement;
    private readonly frameKind: HTMLElement;
    private readonly transferSize: HTMLElement;
    private readonly prevBtn: HTMLButtonElement;
    private readonly playBtn: HTMLButtonElement;
    private readonly nextBtn: HTMLButtonElement;
    private readonly replayBtn: HTMLButtonElement;
    private readonly speedInput: HTMLInputElement;
    private readonly speedOutput: HTMLOutputElement;
    private readonly runtimeStatus: HTMLElement;
    private readonly video: HTMLVideoElement;
    private readonly scanCanvas: HTMLCanvasElement;
    private readonly startCameraBtn: HTMLButtonElement;
    private readonly stopCameraBtn: HTMLButtonElement;
    private readonly receiveTransfer: HTMLElement;
    private readonly receiveProgress: HTMLElement;
    private readonly recommendedSpeed: HTMLElement;
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
    private scanStream: MediaStream | null = null;
    private scanActive = false;
    private scanBusy = false;
    private nativeDetector: NativeBarcodeDetector | null = null;
    private lastRawScan = '';
    private lastDecodeAt = 0;
    private decodeIntervals: number[] = [];
    private objectUrl: string | null = null;
    private receiveHeader: Extract<ParsedFrame, { kind: 'header' }> | null = null;
    private receiveFooter: Extract<ParsedFrame, { kind: 'footer' }> | null = null;
    private readonly receiveChunks = new Map<number, Uint8Array>();

    constructor(root: HTMLElement) {
        this.root = root;
        this.modeToggle = must(root, '[data-bb-mode-toggle]', HTMLInputElement);
        this.kindToggle = must(root, '[data-bb-kind-toggle]', HTMLInputElement);
        this.sendPanel = must(root, '[data-bb-send-panel]', HTMLElement);
        this.receivePanel = must(root, '[data-bb-receive-panel]', HTMLElement);
        this.textField = must(root, '[data-bb-text-field]', HTMLElement);
        this.fileField = must(root, '[data-bb-file-field]', HTMLElement);
        this.textInput = must(root, '[data-bb-text-input]', HTMLTextAreaElement);
        this.fileInput = must(root, '[data-bb-file-input]', HTMLInputElement);
        this.fileMeta = must(root, '[data-bb-file-meta]', HTMLElement);
        this.dropzone = must(root, '[data-bb-dropzone]', HTMLElement);
        this.prepareBtn = must(root, '[data-bb-prepare]', HTMLButtonElement);
        this.fastPreset = must(root, '[data-bb-fast-preset]', HTMLInputElement);
        this.qrStage = must(root, '[data-bb-qr-stage]', HTMLElement);
        this.inputPanel = must(root, '[data-bb-input-panel]', HTMLElement);
        this.qrCanvas = must(root, '[data-bb-qr-canvas]', HTMLCanvasElement);
        this.frameLabel = must(root, '[data-bb-frame-label]', HTMLElement);
        this.frameKind = must(root, '[data-bb-frame-kind]', HTMLElement);
        this.transferSize = must(root, '[data-bb-transfer-size]', HTMLElement);
        this.prevBtn = must(root, '[data-bb-prev]', HTMLButtonElement);
        this.playBtn = must(root, '[data-bb-play]', HTMLButtonElement);
        this.nextBtn = must(root, '[data-bb-next]', HTMLButtonElement);
        this.replayBtn = must(root, '[data-bb-replay]', HTMLButtonElement);
        this.speedInput = must(root, '[data-bb-speed]', HTMLInputElement);
        this.speedOutput = must(root, '[data-bb-speed-output]', HTMLOutputElement);
        this.runtimeStatus = must(root, '[data-bb-runtime-status]', HTMLElement);
        this.video = must(root, '[data-bb-video]', HTMLVideoElement);
        this.scanCanvas = must(root, '[data-bb-scan-canvas]', HTMLCanvasElement);
        this.startCameraBtn = must(root, '[data-bb-start-camera]', HTMLButtonElement);
        this.stopCameraBtn = must(root, '[data-bb-stop-camera]', HTMLButtonElement);
        this.receiveTransfer = must(root, '[data-bb-receive-transfer]', HTMLElement);
        this.receiveProgress = must(root, '[data-bb-receive-progress]', HTMLElement);
        this.recommendedSpeed = must(root, '[data-bb-recommended-speed]', HTMLElement);
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
        this.syncSpeed();
        this.runtimeStatus.textContent = 'Offline client';
    }

    private bindEvents(): void {
        this.modeToggle.addEventListener('change', () => {
            this.mode = this.modeToggle.checked ? 'receive' : 'send';
            this.syncMode();
        });

        this.kindToggle.addEventListener('change', () => {
            this.payloadKind = this.kindToggle.checked ? 'file' : 'text';
            this.syncKind();
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

        this.prepareBtn.addEventListener('click', () => void this.prepareTransfer());
        this.prevBtn.addEventListener('click', () => this.showFrame(this.frameIndex - 1, false));
        this.nextBtn.addEventListener('click', () => this.showFrame(this.frameIndex + 1, false));
        this.playBtn.addEventListener('click', () => this.togglePlayback());
        this.replayBtn.addEventListener('click', () => this.replay());

        this.speedInput.addEventListener('input', () => {
            this.syncSpeed();
            if (this.isPlaying) this.scheduleNextFrame();
        });

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
        this.resetPreparedTransfer();
    }

    private syncSpeed(): void {
        this.speedOutput.value = `${this.frameDelay()}ms`;
        this.speedOutput.textContent = `${this.frameDelay()}ms`;
    }

    private frameDelay(): number {
        return clamp(Number(this.speedInput.value) || 600, 250, 1500);
    }

    private setSelectedFile(file: File | null): void {
        this.selectedFile = file;
        if (!file) {
            this.fileMeta.textContent = 'No file selected';
            return;
        }

        this.fileMeta.textContent = `${file.name} - ${formatBytes(file.size)}`;
        this.resetPreparedTransfer();
    }

    private resetPreparedTransfer(): void {
        this.stopPlayback();
        this.frames = [];
        this.frameIndex = 0;
        this.qrStage.hidden = true;
        this.inputPanel.hidden = false;
    }

    private async prepareTransfer(): Promise<void> {
        try {
            if (this.payloadKind === 'text') {
                const text = this.textInput.value;
                if (!text.trim()) {
                    this.runtimeStatus.textContent = 'Text required';
                    return;
                }

                const transfer = createTextTransfer(text);
                this.frames = [{
                    payload: transfer.frame,
                    label: 'Frame 1 of 1',
                    detail: `Text - ${formatBytes(transfer.byteSize)} - CRC ${transfer.crcHex}`,
                    ecc: 'medium'
                }];
            } else {
                if (!this.selectedFile) {
                    this.runtimeStatus.textContent = 'File required';
                    return;
                }

                const bytes = new Uint8Array(await this.selectedFile.arrayBuffer());
                const transfer = createFileTransfer(bytes, this.selectedFile.name, {
                    fast: this.fastPreset.checked
                });

                this.frames = transfer.frames.map((payload, index) => ({
                    payload,
                    label: `Frame ${index + 1} of ${transfer.frames.length}`,
                    detail: this.describeFileFrame(index, transfer.frames.length, transfer),
                    ecc: transfer.ecc
                }));
            }

            this.inputPanel.hidden = true;
            this.qrStage.hidden = false;
            this.showFrame(0, this.frames.length > 1);
        } catch (error) {
            console.error('[BlinkBridge] Prepare failed', error);
            this.runtimeStatus.textContent = 'Prepare failed';
        }
    }

    private describeFileFrame(
        index: number,
        total: number,
        transfer: { filename: string; byteSize: number; crcHex: string; dataFrameCount: number; chunkSize: number }
    ): string {
        if (index === 0) {
            return `Header - ${transfer.dataFrameCount} chunks - ${transfer.filename}`;
        }

        if (index === total - 1) {
            return `Footer - ${formatBytes(transfer.byteSize)} - CRC ${transfer.crcHex}`;
        }

        return `Chunk ${index} of ${transfer.dataFrameCount} - ${transfer.chunkSize} byte target`;
    }

    private showFrame(nextIndex: number, play: boolean): void {
        if (!this.frames.length) return;

        this.frameIndex = clamp(nextIndex, 0, this.frames.length - 1);
        const frame = this.frames[this.frameIndex];
        this.renderQr(frame.payload, frame.ecc);
        this.frameLabel.textContent = frame.label;
        this.frameKind.textContent = frame.payload.slice(0, 3);
        this.transferSize.textContent = frame.detail;
        this.prevBtn.disabled = this.frameIndex === 0;
        this.nextBtn.disabled = this.frameIndex === this.frames.length - 1;

        this.isPlaying = play && this.frames.length > 1 && this.frameIndex < this.frames.length - 1;
        this.playBtn.textContent = this.isPlaying ? 'Pause' : (this.frameIndex === this.frames.length - 1 ? 'Replay' : 'Play');

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
        if (!this.frames.length) return;

        if (this.frameIndex === this.frames.length - 1) {
            this.replay();
            return;
        }

        if (this.isPlaying) {
            this.stopPlayback();
            this.playBtn.textContent = 'Play';
        } else {
            this.isPlaying = true;
            this.playBtn.textContent = 'Pause';
            this.scheduleNextFrame();
        }
    }

    private replay(): void {
        if (!this.frames.length) return;
        this.showFrame(0, this.frames.length > 1);
    }

    private scheduleNextFrame(): void {
        this.stopPlaybackTimer();
        if (!this.isPlaying || this.frameIndex >= this.frames.length - 1) return;

        this.playTimer = window.setTimeout(() => {
            const shouldContinue = this.frameIndex + 1 < this.frames.length - 1;
            this.showFrame(this.frameIndex + 1, shouldContinue);
        }, this.frameDelay());
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
            this.resetReceiver();
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
            this.receiveStatus.textContent = 'Scanning.';
            this.runtimeStatus.textContent = this.nativeDetector ? 'Native scanner' : 'Canvas scanner';
            this.queueScan();
        } catch (error) {
            console.error('[BlinkBridge] Camera failed', error);
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
                .catch((error) => console.debug('[BlinkBridge] Scan miss', error))
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
        const now = performance.now();
        if (this.lastDecodeAt) {
            this.decodeIntervals.push(now - this.lastDecodeAt);
            this.decodeIntervals = this.decodeIntervals.slice(-12);
            const recommendation = clamp(Math.ceil(median(this.decodeIntervals) * 1.8 / 50) * 50, 250, 1500);
            this.recommendedSpeed.textContent = `${recommendation}ms`;
        }
        this.lastDecodeAt = now;

        const frame = parseBlinkBridgeFrame(raw);
        if (!frame) {
            this.receiveStatus.textContent = 'Unsupported QR.';
            return;
        }

        this.handleReceivedFrame(frame);
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

    private handleReceivedFrame(frame: ParsedFrame): void {
        if (frame.kind === 'text') {
            this.showTextResult(frame.text, frame.size, frame.crcHex);
            return;
        }

        if (frame.kind === 'header') {
            const isNewTransfer =
                !this.receiveHeader
                || this.receiveHeader.crcHex !== frame.crcHex
                || this.receiveHeader.size !== frame.size
                || this.receiveHeader.filename !== frame.filename;

            if (isNewTransfer) {
                this.resetReceiver(false);
                this.receiveHeader = frame;
            }

            this.receiveStatus.textContent = `Header received for ${frame.filename}.`;
            this.syncReceiveProgress();
            return;
        }

        if (frame.kind === 'data') {
            if (!this.receiveHeader) {
                this.receiveStatus.textContent = `Chunk ${frame.index} received before header.`;
                return;
            }

            if (frame.index > this.receiveHeader.count) {
                this.receiveStatus.textContent = `Unexpected chunk ${frame.index}.`;
                return;
            }

            this.receiveChunks.set(frame.index, frame.data);
            this.receiveStatus.textContent = `Chunk ${frame.index} received.`;
            this.syncReceiveProgress();
            this.tryCompleteFile();
            return;
        }

        this.receiveFooter = frame;
        this.receiveStatus.textContent = `Footer received for ${frame.filename}.`;
        this.syncReceiveProgress();
        this.tryCompleteFile();
    }

    private syncReceiveProgress(): void {
        if (!this.receiveHeader) {
            this.receiveTransfer.textContent = 'Waiting';
            this.receiveProgress.textContent = '0 / 0';
            return;
        }

        const missing = findMissingIndexes(this.receiveChunks, this.receiveHeader.count);
        this.receiveTransfer.textContent = `${this.receiveHeader.filename} - ${formatBytes(this.receiveHeader.size)}`;
        this.receiveProgress.textContent = `${this.receiveChunks.size} / ${this.receiveHeader.count}`;

        if (missing.length && this.receiveFooter) {
            this.receiveStatus.textContent = `Missing chunks: ${missing.join(', ')}`;
        }
    }

    private tryCompleteFile(): void {
        if (!this.receiveHeader) return;

        const assembled = assembleChunks(this.receiveChunks, this.receiveHeader.count);
        if (!assembled) return;

        const footer = this.receiveFooter;
        const expectedSize = footer?.size ?? this.receiveHeader.size;
        const expectedCrc = footer?.crcHex ?? this.receiveHeader.crcHex;

        if (assembled.length !== expectedSize) {
            this.receiveStatus.textContent = `Size mismatch: ${assembled.length} of ${expectedSize}.`;
            return;
        }

        const actualCrc = crc32Hex(assembled);
        if (actualCrc !== expectedCrc) {
            this.receiveStatus.textContent = `CRC mismatch: ${actualCrc} expected ${expectedCrc}.`;
            return;
        }

        this.showFileResult(assembled, footer?.filename || this.receiveHeader.filename, actualCrc);
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
        this.receiveFooter = null;
        this.receiveChunks.clear();
        this.lastRawScan = '';
        this.lastDecodeAt = 0;
        this.decodeIntervals = [];
        this.resultPanel.hidden = true;
        this.resultText.value = '';
        this.downloadLink.hidden = true;
        this.copyBtn.hidden = true;
        this.resultText.hidden = true;
        this.receiveTransfer.textContent = 'Waiting';
        this.receiveProgress.textContent = '0 / 0';
        this.recommendedSpeed.textContent = '600ms';
        if (clearStatus) this.receiveStatus.textContent = this.scanActive ? 'Scanning.' : 'Camera idle.';
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

    new BlinkBridgeApp(root).boot();
    document.body.dataset.initialState = 'ready';
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
