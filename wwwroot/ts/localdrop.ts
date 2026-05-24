import encodeQR from 'qr';
import jsQR from 'jsqr';
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
const SCAN_INTERVAL_MS = 50;
const PLACEHOLDER_QR_PAYLOAD = 'LocalDrop';
const RECEIVER_FAILURE_LIMIT = 3;
const INDIUM_DIALOGS_MODULE = '/apps/indium/dist/components/dialogs.js';

interface TransferFrame {
    payload: string;
    label: string;
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
    private readonly fullscreenBtn: HTMLButtonElement;
    private readonly playBtn: HTMLButtonElement;
    private readonly nextBtn: HTMLButtonElement;
    private readonly runtimeStatus: HTMLElement;
    private readonly video: HTMLVideoElement;
    private readonly videoFrame: HTMLElement;
    private readonly scanCanvas: HTMLCanvasElement;
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
    private transferClockTimer = 0;
    private isPlaying = false;
    private hasPlayedOnce = false;
    private transferStartedAt = 0;
    private prepareSequence = 0;
    private textInputTimer = 0;
    private scanStream: MediaStream | null = null;
    private scanInterval = 0;
    private scanActive = false;
    private scanBusy = false;
    private receiverFailureCount = 0;
    private receiverErrorDialogOpen = false;
    private fallbackFullscreen = false;
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
        this.fullscreenBtn = must(root, '[data-bb-fullscreen]', HTMLButtonElement);
        this.playBtn = must(root, '[data-bb-play]', HTMLButtonElement);
        this.nextBtn = must(root, '[data-bb-next]', HTMLButtonElement);
        this.runtimeStatus = must(root, '[data-bb-runtime-status]', HTMLElement);
        this.video = must(root, '[data-bb-video]', HTMLVideoElement);
        this.videoFrame = must(root, '.bb-video-frame', HTMLElement);
        this.scanCanvas = must(root, '[data-bb-scan-canvas]', HTMLCanvasElement);
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
            const nextKind: PayloadKind = this.payloadKind === 'text' ? 'file' : 'text';
            this.payloadKind = nextKind;
            this.syncKind();
            if (nextKind === 'text') {
                this.textInput.focus();
                void this.prepareTransfer();
            } else {
                this.fileInput.click();
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
        this.fullscreenBtn.addEventListener('click', () => void this.toggleFullscreen());
        this.nextBtn.addEventListener('click', () => this.showFrame(this.frameIndex + 1, false));
        this.playBtn.addEventListener('click', () => this.togglePlayback());

        document.addEventListener('fullscreenchange', () => this.syncFullscreenState());
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.fallbackFullscreen) {
                this.closeFallbackFullscreen();
            }
        });

        this.resetReceiverBtn.addEventListener('click', () => this.resetReceiver());
        this.copyBtn.addEventListener('click', () => void this.copyTextResult());
    }

    private syncMode(): void {
        this.sendPanel.hidden = this.mode !== 'send';
        this.receivePanel.hidden = this.mode !== 'receive';

        if (this.mode === 'receive') {
            this.stopPlayback();
            void this.startCamera();
        } else {
            this.stopCamera();
        }
    }

    private syncKind(): void {
        this.textField.hidden = this.payloadKind !== 'text';
        this.fileField.hidden = this.payloadKind !== 'file';
        const isFile = this.payloadKind === 'file';
        this.contentToggle.setAttribute('aria-label', isFile ? 'Switch to text entry' : 'Switch to file upload');
        this.contentToggleLabel.textContent = isFile ? 'Text' : 'Upload';
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
        this.hasPlayedOnce = false;
        this.transferStartedAt = 0;
        this.showPlaceholderQr();
    }

    private showPlaceholderQr(): void {
        this.qrStage.hidden = false;
        this.qrStage.classList.add('bb-qr-stage--placeholder');
        this.renderQr(PLACEHOLDER_QR_PAYLOAD, 'medium');
        this.frameLabel.textContent = 'Frame 0 of 0';
        this.frameKind.textContent = '';
        this.transferSize.textContent = 'Transfer time: 0 min 0 sec';
        this.prevBtn.disabled = true;
        this.nextBtn.disabled = true;
        this.fullscreenBtn.disabled = false;
        this.playBtn.disabled = true;
        this.playBtn.textContent = 'Begin';
    }

    private async prepareTransfer(): Promise<void> {
        const sequence = ++this.prepareSequence;

        try {
            let transfer: PreparedTransfer;
            if (this.payloadKind === 'text') {
                if (!this.textInput.value.trim()) {
                    this.runtimeStatus.textContent = 'Offline client';
                    this.resetPreparedTransfer();
                    return;
                }

                transfer = await createTextTransfer(this.textInput.value, this.receiveUrl());
            } else {
                if (!this.selectedFile) {
                    this.runtimeStatus.textContent = 'Offline client';
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
                ecc: transfer.ecc
            }));
            this.qrStage.hidden = false;
            this.qrStage.classList.remove('bb-qr-stage--placeholder');
            this.showFrame(0, false);
            this.runtimeStatus.textContent = this.preparedTransferStatus(transfer);
        } catch (error) {
            console.error('[LocalDrop] Prepare failed', error);
            this.runtimeStatus.textContent = 'Prepare failed';
        }
    }

    private showFrame(nextIndex: number, play: boolean): void {
        if (!this.frames.length) return;

        this.frameIndex = clamp(nextIndex, 0, this.frames.length - 1);
        const frame = this.frames[this.frameIndex];
        this.renderQr(frame.payload, frame.ecc);
        this.frameLabel.textContent = this.frameLabelText();
        this.frameKind.textContent = '';
        this.transferSize.textContent = this.transferTimeText();
        this.prevBtn.disabled = this.frameIndex === 0;
        this.nextBtn.disabled = this.frameIndex === this.frames.length - 1;
        this.fullscreenBtn.disabled = false;
        this.isPlaying = play && this.frames.length > 1 && this.frameIndex < this.frames.length - 1;
        this.playBtn.disabled = this.frames.length <= 1;
        this.playBtn.textContent = this.playbackButtonText();

        if (this.isPlaying) {
            if (!this.transferStartedAt) this.transferStartedAt = Date.now();
            this.startTransferClock();
            this.scheduleNextFrame();
        } else {
            this.stopTransferClock();
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
        const targetSize = 720;
        const moduleSize = Math.max(1, Math.floor(targetSize / size));
        const canvasSize = moduleSize * size;

        this.qrCanvas.width = canvasSize;
        this.qrCanvas.height = canvasSize;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasSize, canvasSize);
        ctx.fillStyle = '#000000';

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (matrix[y][x]) {
                    ctx.fillRect(x * moduleSize, y * moduleSize, moduleSize, moduleSize);
                }
            }
        }
    }

    private preparedTransferStatus(transfer: PreparedTransfer): string {
        if (transfer.header.kind === 'file' && transfer.frames.length > 20) {
            return `Large transfer - ${transfer.frames.length} QR frames. For this size, Bluetooth or another OS-level file transfer is recommended.`;
        }

        return transfer.header.kind === 'text'
            ? `Text ready - ${formatBytes(transfer.byteSize)}`
            : `File ready - ${formatBytes(transfer.byteSize)}`;
    }

    private togglePlayback(): void {
        if (!this.frames.length || this.frames.length <= 1) return;

        if (this.isPlaying) {
            this.stopPlayback();
            this.playBtn.textContent = this.playbackButtonText();
            this.transferSize.textContent = this.transferTimeText();
            return;
        }

        this.transferStartedAt = Date.now();
        this.showFrame(this.frameIndex === 0 || this.frameIndex === this.frames.length - 1 ? 1 : this.frameIndex, true);
    }

    private async toggleFullscreen(): Promise<void> {
        if (document.fullscreenElement === this.qrStage || this.fallbackFullscreen) {
            await this.exitFullscreen();
            return;
        }

        if (this.qrStage.requestFullscreen) {
            try {
                await this.qrStage.requestFullscreen();
                this.syncFullscreenState();
                return;
            } catch (error) {
                console.debug('[LocalDrop] Native fullscreen unavailable', error);
            }
        }

        this.openFallbackFullscreen();
    }

    private async exitFullscreen(): Promise<void> {
        if (document.fullscreenElement === this.qrStage && document.exitFullscreen) {
            await document.exitFullscreen();
            return;
        }

        this.closeFallbackFullscreen();
    }

    private openFallbackFullscreen(): void {
        this.fallbackFullscreen = true;
        this.qrStage.classList.add('bb-qr-stage--fullscreen');
        document.body.classList.add('bb-fullscreen-lock');
        this.syncFullscreenState();
    }

    private closeFallbackFullscreen(): void {
        this.fallbackFullscreen = false;
        this.qrStage.classList.remove('bb-qr-stage--fullscreen');
        document.body.classList.remove('bb-fullscreen-lock');
        this.syncFullscreenState();
    }

    private syncFullscreenState(): void {
        const active = document.fullscreenElement === this.qrStage || this.fallbackFullscreen;
        if (!active && this.fallbackFullscreen) {
            this.fallbackFullscreen = false;
            this.qrStage.classList.remove('bb-qr-stage--fullscreen');
            document.body.classList.remove('bb-fullscreen-lock');
        }
        this.fullscreenBtn.textContent = active ? 'Exit' : 'Fullscreen';
        this.fullscreenBtn.setAttribute('aria-label', active ? 'Exit fullscreen QR view' : 'Open fullscreen QR view');
    }

    private scheduleNextFrame(): void {
        this.stopPlaybackTimer();
        if (!this.isPlaying || this.frameIndex >= this.frames.length - 1) return;

        this.playTimer = window.setTimeout(() => {
            const nextIndex = this.frameIndex + 1;
            if (nextIndex >= this.frames.length - 1) {
                this.hasPlayedOnce = true;
            }
            this.showFrame(nextIndex, nextIndex < this.frames.length - 1);
        }, FRAME_INTERVAL_MS);
    }

    private stopPlayback(): void {
        this.isPlaying = false;
        this.stopTransferClock();
        this.stopPlaybackTimer();
    }

    private frameLabelText(): string {
        return `Frame ${this.frameIndex + 1} of ${this.frames.length}`;
    }

    private playbackButtonText(): string {
        if (this.isPlaying) return 'Pause';
        return this.hasPlayedOnce ? 'Restart' : 'Begin';
    }

    private transferTimeText(): string {
        const remainingFrames = Math.max(0, this.frames.length - this.frameIndex - 1);
        const estimatedTotalMs = Math.max(0, (this.frames.length - 1) * FRAME_INTERVAL_MS);
        const elapsedMs = this.transferStartedAt ? Math.max(0, Date.now() - this.transferStartedAt) : 0;
        const remainingMs = this.isPlaying
            ? Math.max(0, estimatedTotalMs - elapsedMs)
            : remainingFrames * FRAME_INTERVAL_MS;

        return `Transfer time: ${this.formatDuration(remainingMs)}`;
    }

    private formatDuration(milliseconds: number): string {
        const totalSeconds = Math.ceil(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes} min ${seconds} sec`;
    }

    private stopPlaybackTimer(): void {
        if (this.playTimer) {
            window.clearTimeout(this.playTimer);
            this.playTimer = 0;
        }
    }

    private startTransferClock(): void {
        if (this.transferClockTimer) return;

        this.transferClockTimer = window.setInterval(() => {
            this.transferSize.textContent = this.transferTimeText();
        }, 250);
    }

    private stopTransferClock(): void {
        if (this.transferClockTimer) {
            window.clearInterval(this.transferClockTimer);
            this.transferClockTimer = 0;
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
            this.receiveStatus.textContent = this.receiveHeader
                ? 'Connection established. Select Begin on the other device.'
                : 'Scanning for connection...';
            this.runtimeStatus.textContent = this.nativeDetector ? 'Native scanner' : 'Canvas scanner';
            this.startScanLoop();
        } catch (error) {
            console.error('[LocalDrop] Camera failed', error);
            this.receiveStatus.textContent = 'Camera unavailable. Ensure one is available + allow camera access.';
            this.stopCamera();
        }
    }

    private stopCamera(): void {
        this.scanActive = false;
        this.scanBusy = false;
        this.stopScanLoop();

        if (this.scanStream) {
            for (const track of this.scanStream.getTracks()) {
                track.stop();
            }
            this.scanStream = null;
        }

        this.video.srcObject = null;
    }

    private startScanLoop(): void {
        this.stopScanLoop();
        this.scanInterval = window.setInterval(() => void this.scanTick(), SCAN_INTERVAL_MS);
        void this.scanTick();
    }

    private stopScanLoop(): void {
        if (this.scanInterval) {
            window.clearInterval(this.scanInterval);
            this.scanInterval = 0;
        }
    }

    private async scanTick(): Promise<void> {
        if (!this.scanActive || this.scanBusy) return;

        this.scanBusy = true;
        try {
            await this.scanOnce();
        } catch (error) {
            console.debug('[LocalDrop] Scan miss', error);
        } finally {
            this.scanBusy = false;
        }
    }

    private async scanOnce(): Promise<void> {
        if (!this.video.videoWidth || !this.video.videoHeight) return;

        let raw = this.scanViaCanvas();

        if (!raw && this.nativeDetector) {
            const results = await this.nativeDetector.detect(this.video);
            raw = results[0]?.rawValue ?? '';
        }

        if (!raw || raw === this.lastRawScan) return;

        this.lastRawScan = raw;
        await this.handleRawFrame(raw);
    }

    private scanViaCanvas(): string {
        const ctx = this.scanCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return '';

        const width = this.video.videoWidth;
        const height = this.video.videoHeight;
        if (this.scanCanvas.width !== width) this.scanCanvas.width = width;
        if (this.scanCanvas.height !== height) this.scanCanvas.height = height;

        ctx.drawImage(this.video, 0, 0, width, height);

        try {
            const image = ctx.getImageData(0, 0, width, height);
            const code = jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' });
            if (code?.data) return code.data;
        } catch {
            // Try the center crop below before giving up.
        }

        return this.scanCenterCrop(ctx, width, height);
    }

    private scanCenterCrop(ctx: CanvasRenderingContext2D, width: number, height: number): string {
        const sourceSize = Math.min(width, height);
        const sx = Math.floor((width - sourceSize) / 2);
        const sy = Math.floor((height - sourceSize) / 2);
        const targetSize = 720;

        this.scanCanvas.width = targetSize;
        this.scanCanvas.height = targetSize;
        ctx.drawImage(this.video, sx, sy, sourceSize, sourceSize, 0, 0, targetSize, targetSize);

        try {
            const image = ctx.getImageData(0, 0, targetSize, targetSize);
            const code = jsQR(image.data, targetSize, targetSize, { inversionAttempts: 'dontInvert' });
            return code?.data ?? '';
        } catch {
            return '';
        }
    }

    private async handleRawFrame(raw: string): Promise<void> {
        const receivedHeader = await parseHeaderUrl(raw);
        if (receivedHeader) {
            this.clearReceiverFailure();
            this.applyReceivedHeader(receivedHeader.header, receivedHeader.key);
            return;
        }

        if (!this.receiveHeader || !this.receiveKey) {
            this.receiveStatus.textContent = 'Scan the connection QR first.';
            this.noteReceiverFailure('Scan the connection QR first.');
            return;
        }

        const chunk = await parseChunkFrame(raw, this.receiveKey);
        if (!chunk) {
            this.noteReceiverFailure('Unsupported QR. Keep the QR inside the blue frame.');
            return;
        }

        if (chunk.index > this.receiveHeader.count) {
            this.noteReceiverFailure(`Unexpected chunk ${chunk.index}.`);
            return;
        }

        this.clearReceiverFailure();
        this.receiveChunks.set(chunk.index, chunk.data);
        this.receiveStatus.textContent = `Receiving file. Chunk ${chunk.index} received.`;
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
                this.noteReceiverFailure('Text validation failed.');
                return;
            }

            this.clearReceiverFailure();
            this.showTextResult(decodeString(bytes), header.size, header.crcHex);
            return;
        }

        this.receiveStatus.textContent = 'Connection established. Select Begin on the other device.';
        this.syncReceiveProgress();
    }

    private syncReceiveProgress(): void {
        if (!this.receiveHeader) {
            this.receiveTransfer.textContent = 'Waiting';
            this.receiveProgress.textContent = this.receiveTransferTimeText();
            return;
        }

        const missing = findMissingIndexes(this.receiveChunks, this.receiveHeader.count);
        const label = this.receiveHeader.kind === 'file'
            ? `${this.receiveHeader.filename} - ${formatBytes(this.receiveHeader.size)}`
            : `Text - ${formatBytes(this.receiveHeader.size)}`;
        this.receiveTransfer.textContent = label;
        this.receiveProgress.textContent = this.receiveTransferTimeText();

        if (missing.length && this.receiveChunks.size > 0) {
            this.receiveStatus.textContent = `Missing chunks: ${missing.join(', ')}`;
        }
    }

    private tryCompleteFile(): void {
        if (!this.receiveHeader || this.receiveHeader.kind !== 'file') return;

        const assembled = assembleChunks(this.receiveChunks, this.receiveHeader.count);
        if (!assembled) return;

        if (assembled.length !== this.receiveHeader.size) {
            this.noteReceiverFailure(`Size mismatch: ${assembled.length} of ${this.receiveHeader.size}.`);
            return;
        }

        const actualCrc = crc32Hex(assembled);
        if (actualCrc !== this.receiveHeader.crcHex) {
            this.noteReceiverFailure(`CRC mismatch: ${actualCrc} expected ${this.receiveHeader.crcHex}.`);
            return;
        }

        this.clearReceiverFailure();
        this.showFileResult(assembled, this.receiveHeader.filename ?? 'localdrop-file', actualCrc);
    }

    private showTextResult(text: string, size: number, crcHex: string): void {
        this.clearObjectUrl();
        this.resultPanel.hidden = false;
        this.resultText.hidden = false;
        this.resultText.value = text;
        this.copyBtn.hidden = false;
        this.downloadLink.hidden = true;
        this.receiveTransfer.textContent = `Text - ${formatBytes(size)}`;
        this.receiveProgress.textContent = this.receiveTransferTimeText(0);
        this.receiveStatus.textContent = `Text received and validated.`;
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
        this.receiveStatus.textContent = `File received and validated.`;
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
        this.clearReceiverFailure();
        this.resultPanel.hidden = true;
        this.resultText.value = '';
        this.downloadLink.hidden = true;
        this.copyBtn.hidden = true;
        this.resultText.hidden = true;
        this.receiveTransfer.textContent = 'Waiting';
        this.receiveProgress.textContent = this.receiveTransferTimeText();
        if (clearStatus) this.receiveStatus.textContent = this.scanActive ? 'Scanning.' : 'Camera idle.';
    }

    private noteReceiverFailure(message: string): void {
        this.receiverFailureCount++;
        this.videoFrame.classList.add('bb-video-frame--warning');
        this.receiveStatus.textContent = message;

        if (this.receiverFailureCount >= RECEIVER_FAILURE_LIMIT) {
            this.resetReceiver(false);
            this.receiveStatus.textContent = 'Transfer reset. Scan the connection QR again.';
            void this.showReceiverFailureDialog();
        }
    }

    private clearReceiverFailure(): void {
        this.receiverFailureCount = 0;
        this.videoFrame.classList.remove('bb-video-frame--warning');
    }

    private async showReceiverFailureDialog(): Promise<void> {
        if (this.receiverErrorDialogOpen) return;

        this.receiverErrorDialogOpen = true;
        try {
            const dialogModule = await import(INDIUM_DIALOGS_MODULE);
            if (typeof dialogModule.showAlert === 'function') {
                await dialogModule.showAlert({
                    title: 'Transfer interrupted',
                    message: 'LocalDrop reset the receiver after repeated scan failures. Hold both devices steady, align the QR inside the blue borders, avoid glare, and use Fullscreen on the sending device before replaying.'
                });
            } else {
                window.alert('Transfer interrupted. Hold both devices steady, align the QR inside the blue borders, avoid glare, and use Fullscreen on the sending device before replaying.');
            }
        } catch {
            window.alert('Transfer interrupted. Hold both devices steady, align the QR inside the blue borders, avoid glare, and use Fullscreen on the sending device before replaying.');
        } finally {
            this.receiverErrorDialogOpen = false;
        }
    }

    private receiveTransferTimeText(remainingFrames?: number): string {
        const frames = remainingFrames ?? (this.receiveHeader
            ? Math.max(0, this.receiveHeader.count - this.receiveChunks.size)
            : 0);
        return `Transfer time: ${this.formatDuration(frames * FRAME_INTERVAL_MS)}`;
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
        return new URL('/localdrop', window.location.origin).toString();
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
