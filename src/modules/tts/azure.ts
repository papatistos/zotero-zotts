import { getPref, setPref } from "../utils/prefs";
import { notifyGeneric } from "../utils/notify";
import { getString } from "../utils/locale";

// Azure Voice API response type
interface AzureVoice {
    Locale: string;
    ShortName: string;
    SecondaryLocaleList?: string[];
}

// Text section splitter for handling long text synthesis
class TextSectionSplitter {
    private static readonly MAX_SECTION_SIZE = 6 * 1024; // 6K characters, ~8 mins, ~$0.1. Azure Speech has TTS audio duration limit of 10 minutes.

    private fullText: string = "";
    private currentIndex: number = 0;

    public initialize(text: string): void {
        this.fullText = text;
        this.currentIndex = 0;
    }

    public hasMore(): boolean {
        return this.currentIndex < this.fullText.length;
    }

    public getNextSection(): string {
        if (!this.hasMore()) {
            return "";
        }

        const sectionEnd = this.findSectionEnd(this.currentIndex);
        const section = this.fullText.substring(this.currentIndex, sectionEnd);
        this.currentIndex = sectionEnd;

        return section;
    }

    public reset(): void {
        this.fullText = "";
        this.currentIndex = 0;
    }

    private findSectionEnd(startIndex: number): number {
        const remaining = this.fullText.length - startIndex;
        if (remaining <= TextSectionSplitter.MAX_SECTION_SIZE) {
            return this.fullText.length;
        }

        // Search backwards from threshold position
        const searchEnd = startIndex + TextSectionSplitter.MAX_SECTION_SIZE;
        const searchText = this.fullText.substring(startIndex, searchEnd);
        const minSearchPos = Math.floor(TextSectionSplitter.MAX_SECTION_SIZE * 0.5);

        // Priority: paragraph boundary > line+indent > punctuation > single line > tab
        // TODO: Tune break patterns
        const breakPatterns = [
            /\n\n/g,    // Paragraph separator
            /\n\t/g,    // Line break + tab (likely paragraph start)
            /\n /g,     // Line break + space (possible paragraph start)
            /:\s/g,     // Colon + whitespace (break after colon)
            /;\s/g,     // Semicolon + whitespace (break after semicolon)
            /\n/g,      // Single line break
            /\t/g,      // Tab character
        ];

        for (const pattern of breakPatterns) {
            let lastMatch: RegExpExecArray | null = null;
            let match: RegExpExecArray | null;

            // Reset regex lastIndex
            pattern.lastIndex = 0;

            // Find all matches and keep the last one that's after minSearchPos
            while ((match = pattern.exec(searchText)) !== null) {
                if (match.index > minSearchPos) {
                    lastMatch = match;
                }
            }

            if (lastMatch) {
                const sectionEnd = startIndex + lastMatch.index + lastMatch[0].length;

                // Log split preview if there's more text after this section
                if (sectionEnd < this.fullText.length) {
                    const previewBefore = this.fullText.substring(Math.max(0, sectionEnd - 30), sectionEnd);
                    const previewAfter = this.fullText.substring(sectionEnd, Math.min(this.fullText.length, sectionEnd + 30));
                    ztoolkit.log(`Split at pattern "${lastMatch[0]}": ...${previewBefore} | ${previewAfter}...`);
                }

                return sectionEnd;
            }
        }

        // No suitable break point found, force split at threshold
        const previewBefore = this.fullText.substring(Math.max(0, searchEnd - 30), searchEnd);
        const previewAfter = this.fullText.substring(searchEnd, Math.min(this.fullText.length, searchEnd + 30));
        ztoolkit.log(`No suitable break point found, forcing split at ${TextSectionSplitter.MAX_SECTION_SIZE}: ...${previewBefore} | ${previewAfter}...`);

        return searchEnd;
    }
}

// Audio player that schedules Azure's raw PCM output back to back with Web Audio.
// Playing every few kilobytes as a separate Ogg file left an audible gap at
// each file switch. Zotero disables WebM, so MediaSource streaming is not an
// option, but Web Audio needs no codec and schedules chunks sample-exactly.
// The speaking rate is applied by Azure through SSML, so pitch stays natural.
class AudioPlayer {
    private static readonly SAMPLE_RATE = 24000; // raw-24khz-16bit-mono-pcm
    private static readonly START_DELAY = 0.05; // seconds of scheduling headroom

    private context: AudioContext | null = null;
    private gainNode: GainNode | null = null;
    private activeSources: Set<AudioBufferSourceNode> = new Set();
    private pendingChunks: Uint8Array[] = [];
    private carryByte: number | null = null; // odd trailing byte of a 16-bit sample
    private receivedBytes: number = 0;
    private nextStartTime: number = 0;
    private hasStarted: boolean = false;
    private isPaused: boolean = false;
    private isSynthesisComplete: boolean = false;
    // Incremented on every reset so callbacks from an old stream are ignored
    private generation: number = 0;
    private onAllSegmentsComplete?: () => void;

    // Bytes of PCM to receive before playback starts
    public preloadBytes: number = 0;

    public async initialize(): Promise<void> {
        if (this.context) {
            return;
        }
        const AudioContextClass = window.AudioContext;
        if (!AudioContextClass) {
            ztoolkit.log("Web Audio AudioContext is not available");
            throw new Error("playback-unsupported");
        }
        this.context = new AudioContextClass();
        this.gainNode = this.context.createGain();
        this.gainNode.connect(this.context.destination);
    }

    public setOnCompleteCallback(callback: () => void): void {
        this.onAllSegmentsComplete = callback;
    }

    // Prepare for one synthesis turn
    public async startStream(): Promise<void> {
        await this.initialize();
        this.resetAudioState();
        this.gainNode!.gain.value = (getPref("azure.volume") as number) / 100;
        if (this.context!.state === "suspended" && !this.isPaused) {
            await this.context!.resume().catch((error) => ztoolkit.log(`AudioContext resume failed: ${error}`));
        }
    }

    public async queueAudioChunk(audioData: Uint8Array): Promise<void> {
        this.pendingChunks.push(audioData);
        this.receivedBytes += audioData.length;
        if (this.hasStarted) {
            this.schedulePending();
        } else {
            this.maybeStartPlayback();
        }
    }

    public async onSynthesisComplete(): Promise<void> {
        this.isSynthesisComplete = true;
        ztoolkit.log(`onSynthesisComplete: received ${this.receivedBytes} bytes`);

        if (this.receivedBytes === 0) {
            // Nothing to play, so no source will end
            this.finish(this.generation);
            return;
        }

        if (this.hasStarted) {
            this.schedulePending();
            this.checkFinished();
        } else {
            this.maybeStartPlayback();
        }
    }

    public pause(): void {
        if (this.isPaused || addon.data.tts.state === "idle") {
            return;
        }
        this.isPaused = true;
        addon.data.tts.state = "paused";
        if (this.hasStarted && this.context) {
            // Suspending freezes the context clock, so scheduled audio resumes in place
            this.context.suspend().catch((error) => ztoolkit.log(`AudioContext suspend failed: ${error}`));
        }
    }

    public resume(): void {
        if (!this.isPaused) {
            return;
        }
        this.isPaused = false;
        addon.data.tts.state = "playing";

        if (this.hasStarted && this.context) {
            this.context.resume().catch((error) => this.onPlaybackError(this.generation, `resume failed: ${error}`));
        } else {
            this.maybeStartPlayback();
        }
    }

    public stop(): void {
        this.resetAudioState();
        if (this.isPaused && this.context) {
            this.context.resume().catch((error) => ztoolkit.log(`AudioContext resume failed: ${error}`));
        }
        this.isPaused = false;
        addon.data.tts.state = "idle";
    }

    public dispose(): void {
        this.stop();
        if (this.context) {
            this.context.close().catch(() => {});
        }
        this.context = null;
        this.gainNode = null;
    }

    private maybeStartPlayback(): void {
        if (this.hasStarted || this.isPaused || !this.context) {
            return;
        }
        if (this.receivedBytes < this.preloadBytes && !this.isSynthesisComplete) {
            return;
        }

        this.hasStarted = true;
        this.nextStartTime = this.context.currentTime + AudioPlayer.START_DELAY;
        ztoolkit.log(`Starting playback after ${this.receivedBytes} bytes`);
        this.schedulePending();
        this.checkFinished();
    }

    // Turn queued PCM into buffers that start exactly where the previous one ends
    private schedulePending(): void {
        const context = this.context;
        const gainNode = this.gainNode;
        if (!context || !gainNode) {
            return;
        }
        const generation = this.generation;
        const chunks = this.pendingChunks;
        this.pendingChunks = [];

        for (const chunk of chunks) {
            const samples = this.toSamples(chunk);
            if (samples.length === 0) {
                continue;
            }

            try {
                const buffer = context.createBuffer(1, samples.length, AudioPlayer.SAMPLE_RATE);
                buffer.copyToChannel(samples, 0);
                const source = context.createBufferSource();
                source.buffer = buffer;
                source.connect(gainNode);

                let startTime = this.nextStartTime;
                if (startTime < context.currentTime) {
                    // Audio arrived later than it was needed; a gap cannot be avoided here
                    ztoolkit.log(`Azure audio underrun of ${(context.currentTime - startTime).toFixed(3)} s`);
                    startTime = context.currentTime + AudioPlayer.START_DELAY;
                }
                source.onended = () => {
                    this.activeSources.delete(source);
                    if (generation === this.generation) {
                        this.checkFinished();
                    }
                };
                source.start(startTime);
                this.activeSources.add(source);
                this.nextStartTime = startTime + buffer.duration;
            } catch (error) {
                this.onPlaybackError(generation, `scheduling failed: ${error}`);
                return;
            }
        }
    }

    // Decode little-endian 16-bit PCM, carrying an odd byte over to the next chunk
    private toSamples(chunk: Uint8Array): Float32Array<ArrayBuffer> {
        let bytes = chunk;
        if (this.carryByte !== null) {
            bytes = new Uint8Array(chunk.length + 1);
            bytes[0] = this.carryByte;
            bytes.set(chunk, 1);
            this.carryByte = null;
        }

        const sampleCount = bytes.length >> 1;
        if (bytes.length % 2 === 1) {
            this.carryByte = bytes[bytes.length - 1];
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
        const samples = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            samples[i] = view.getInt16(i * 2, true) / 32768;
        }
        return samples;
    }

    private checkFinished(): void {
        if (this.hasStarted && this.isSynthesisComplete
            && this.pendingChunks.length === 0 && this.activeSources.size === 0) {
            this.finish(this.generation);
        }
    }

    private finish(generation: number): void {
        if (generation !== this.generation) {
            return;
        }
        this.resetAudioState();

        if (this.onAllSegmentsComplete) {
            this.onAllSegmentsComplete();
        } else {
            addon.data.tts.state = "idle";
        }
    }

    private onPlaybackError(generation: number, message: string): void {
        if (generation !== this.generation) {
            return;
        }
        ztoolkit.log(`Azure audio playback error: ${message}`);
        this.stop();
        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: "azure" } }),
             getString("popup-engineErrorCause", { args: { engine: "azure", cause: "playback-failed" } })],
            "error"
        );
    }

    private resetAudioState(): void {
        this.generation++;

        for (const source of this.activeSources) {
            source.onended = null;
            try {
                source.stop();
            } catch (error) {
                // Already stopped
            }
        }
        this.activeSources.clear();

        this.pendingChunks = [];
        this.carryByte = null;
        this.receivedBytes = 0;
        this.nextStartTime = 0;
        this.hasStarted = false;
        this.isSynthesisComplete = false;
    }
}

// WebSocket v1 connection manager for Azure Speech (SSML in, PCM audio out)
class AzureStreamingSynthesizer {
    private static readonly TURN_START_TIMEOUT = 10000;

    private ws: WebSocket | null = null;
    private requestId: string = "";
    private audioPlayer: AudioPlayer;
    private textSplitter: TextSectionSplitter;
    private isConnected: boolean = false;
    private isStopped: boolean = false;
    private turnStartResolve: (() => void) | null = null;
    private turnStartReject: ((reason?: unknown) => void) | null = null;

    constructor() {
        this.audioPlayer = new AudioPlayer();
        this.textSplitter = new TextSectionSplitter();
        this.audioPlayer.setOnCompleteCallback(() => this.onAudioComplete());
    }

    public async connect(): Promise<void> {
        if (this.isConnected && this.ws && this.ws.readyState === window.WebSocket.OPEN) {
            return;
        }

        const { key: subscriptionKey, region } = getAzureConfig();

        if (!subscriptionKey || !region) {
            throw new Error("auth-failed");
        }

        this.requestId = this.generateGuid();
        const connectionId = this.generateGuid();

        // Build WebSocket URL
        let wsUrl = `wss://${region}.tts.speech.microsoft.com/cognitiveservices/websocket/v1`;
        wsUrl += `?ConnectionId=${connectionId}`;
        wsUrl += `&X-ConnectionId=${connectionId}`;

        // Add subscription key to URL if provided
        if (subscriptionKey) {
            wsUrl += `&Ocp-Apim-Subscription-Key=${encodeURIComponent(subscriptionKey)}`;
        }

        return new Promise((resolve, reject) => {
            try {
                this.ws = new window.WebSocket(wsUrl);
                this.ws.binaryType = "arraybuffer";

                this.ws.onopen = () => {
                    this.isConnected = true;
                    resolve();
                };

                this.ws.onmessage = async (event) => {
                    await this.handleMessage(event.data);
                };

                this.ws.onerror = (error) => {
                    ztoolkit.log(`WebSocket error: ${error}`);
                    if (!this.isConnected) {
                        reject(new Error("connection-failed"));
                    }
                };

                this.ws.onclose = (event) => {
                    const wasConnected = this.isConnected;
                    this.isConnected = false;
                    // Only notify if connection was previously established and then dropped
                    // Connection failures are handled by speak().catch()
                    if (event.code !== 1000 && !this.isStopped && wasConnected) {
                        ztoolkit.log(`WebSocket closed unexpectedly: ${event.code} ${event.reason}`);
                        notifyGeneric(
                            [getString("popup-engineErrorTitle", { args: { engine: "azure" } }),
                             getString("popup-engineErrorCause", { args: { engine: "azure", cause: "connection-closed" } })],
                            "error"
                        );
                    }
                };

            } catch (error) {
                reject(error);
            }
        });
    }

    public async speak(text: string): Promise<void> {
        // Stop any previous playback
        if (this.audioPlayer) {
            this.audioPlayer.stop();
        }

        // Initialize text section splitting
        this.textSplitter.initialize(text);
        this.isStopped = false;

        // Get first section
        const firstSection = this.textSplitter.getNextSection();
        ztoolkit.log(`Azure speak: total ${text.length} chars, first section ${firstSection.length} chars, hasMore: ${this.textSplitter.hasMore()}`);

        // Synthesize first section
        await this.speakSection(firstSection);

        // Check if stopped during synthesis
        if (this.isStopped) {
            return;
        }
    }

    private async speakSection(sectionText: string): Promise<void> {
        // Early return if stopped
        if (this.isStopped) {
            return;
        }

        // Read configuration from preferences
        const languageId = (getPref("azure.language") as string || "").trim();
        const voiceName = (getPref("azure.voice") as string || "").trim();
        // The preload setting was sized for Opus at ~3 KB per second of speech;
        // PCM needs 48 KB per second, so keep the same duration of preloaded audio
        const minSegmentSizeKB = getPref("azure.minSegmentSize") as number || 8;
        this.audioPlayer.preloadBytes = minSegmentSizeKB * 1024 * 16;

        if (!languageId || !voiceName) {
            ztoolkit.log(`Azure TTS configuration incomplete: language="${languageId}", voice="${voiceName}"`);
            throw new Error("config-incomplete");
        }

        // Generate new requestId for each section
        this.requestId = this.generateGuid();

        await this.connect();

        // Check if stopped after connection
        if (this.isStopped) {
            return;
        }

        // Open a fresh audio stream before Azure starts sending audio
        await this.audioPlayer.startStream();

        // Check if stopped while the stream was opening
        if (this.isStopped) {
            return;
        }

        // Send speech.config
        const configMessage = this.buildMessage('speech.config', {
            context: {
                system: { name: "ZoTTS", version: "1.0.0", build: "JavaScript", lang: "JavaScript" }
            }
        });
        this.ws?.send(configMessage);

        // Send synthesis.context
        const contextMessage = this.buildMessage('synthesis.context', {
            synthesis: {
                audio: {
                    metadataOptions: {
                        sentenceBoundaryEnabled: false,
                        wordBoundaryEnabled: false,
                        visemeEnabled: false,
                        bookmarkEnabled: false,
                        punctuationBoundaryEnabled: false,
                        sessionEndEnabled: true
                    },
                    outputFormat: 'raw-24khz-16bit-mono-pcm'
                },
                language: {
                    autoDetection: false
                }
            }
        });
        this.ws?.send(contextMessage);

        // Wait for turn.start response
        const turnStartPromise = new Promise<void>((resolve, reject) => {
            this.turnStartResolve = resolve;
            this.turnStartReject = reject;
        });

        // Send the whole section as SSML, so Azure applies the speaking rate itself
        const rate = getPref("azure.rate") as number || 100;
        ztoolkit.log(`Sending section SSML: ${sectionText.length} characters`);
        addon.data.tts.state = "playing";
        this.ws?.send(this.buildMessage('ssml', buildSsml(sectionText, voiceName, languageId, rate), 'application/ssml+xml'));

        try {
            await Promise.race([
                turnStartPromise,
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error("Timeout waiting for turn.start")), AzureStreamingSynthesizer.TURN_START_TIMEOUT)
                )
            ]);
        } catch (error) {
            if (this.isStopped) {
                ztoolkit.log("Synthesis cancelled while waiting for turn.start");
                return;
            }
            ztoolkit.log(`Error waiting for turn.start: ${error}`);
            throw error;
        }

        ztoolkit.log(`Section text sent, waiting for audio synthesis to complete`);
    }

    public stop(): void {
        this.isStopped = true;

        // Interrupt waiting for turn.start if in progress
        if (this.turnStartReject) {
            this.turnStartReject(new Error("Cancelled by user"));
            this.turnStartReject = null;
            this.turnStartResolve = null;
        }

        this.textSplitter.reset();
        this.audioPlayer.stop();
        addon.data.tts.state = "idle";
    }

    public pause(): void {
        this.audioPlayer.pause();
    }

    public resume(): void {
        this.audioPlayer.resume();
    }

    public disconnect(): void {
        if (this.ws) {
            this.ws.close(1000, "Normal closure");
            this.ws = null;
        }
        this.isConnected = false;
    }

    public dispose(): void {
        this.stop();
        this.disconnect();
        this.audioPlayer.dispose();
    }

    private async onAudioComplete(): Promise<void> {
        // Early return if stopped
        if (this.isStopped) {
            this.textSplitter.reset();
            addon.data.tts.state = "idle";
            return;
        }

        // Check if there are more text sections to synthesize
        if (this.textSplitter.hasMore()) {
            const nextSection = this.textSplitter.getNextSection();
            ztoolkit.log(`Continuing with next section: ${nextSection.length} chars, hasMore: ${this.textSplitter.hasMore()}`);

            try {
                await this.speakSection(nextSection);
            } catch (error) {
                ztoolkit.log(`Error synthesizing section: ${error}`);
                this.textSplitter.reset();
                addon.data.tts.state = "idle";
            }
        } else {
            // All text sections completed
            ztoolkit.log('All text sections completed');
            this.textSplitter.reset();
            addon.data.tts.state = "idle";
        }
    }

    private generateGuid(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    private generateTimestamp(): string {
        return new Date().toISOString();
    }

    private buildMessage(path: string, body: string | Record<string, unknown>, contentType: string = 'application/json'): string {
        const timestamp = this.generateTimestamp();
        const headers = [
            `X-Timestamp:${timestamp}`,
            `X-RequestId:${this.requestId}`,
            `Path:${path}`,
            `Content-Type:${contentType}`,
            '',
            ''
        ];

        // String bodies (SSML, text) are sent as-is; objects are sent as JSON
        const content = typeof body === 'string' ? body : JSON.stringify(body);
        return headers.join('\r\n') + content;
    }

    private async handleMessage(data: ArrayBuffer | string): Promise<void> {
        if (typeof data === 'string') {
            // Parse text message headers
            const headerEnd = data.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                return;
            }

            const headerText = data.substring(0, headerEnd);
            const lines = headerText.split('\r\n');

            // Extract Path header
            let path = '';
            for (const line of lines) {
                if (line.startsWith('Path:')) {
                    path = line.substring(5).trim();
                    break;
                }
            }

            // Process based on path
            if (path === 'turn.start') {
                ztoolkit.log('turn.start received');
                if (this.turnStartResolve) {
                    this.turnStartResolve();
                    this.turnStartResolve = null;
                    this.turnStartReject = null;
                }
            } else if (path === 'turn.end') {
                ztoolkit.log(`turn.end received`);
                // Mark synthesis as complete and trigger final playback
                await this.audioPlayer.onSynthesisComplete();
            } else if (path === 'response') {
                // Ignore response messages
            } else {
                // Log unknown message types
                ztoolkit.log(`Unknown text message: Path=${path}`);
            }

            return;
        }

        // Binary message - Azure uses 2-byte length prefix for headers
        const view = new Uint8Array(data);

        // Validate minimum length
        if (view.length < 2) {
            ztoolkit.log(`Binary message too short: ${view.length} bytes`);
            return;
        }

        // Read header length (big-endian)
        const headerLength = (view[0] << 8) | view[1];

        // Validate complete message
        if (view.length < 2 + headerLength) {
            ztoolkit.log(`Binary message incomplete: expected ${2 + headerLength} bytes, got ${view.length}`);
            return;
        }

        // Extract and parse headers
        const headerBytes = view.slice(2, 2 + headerLength);
        const headerText = new TextDecoder('utf-8').decode(headerBytes);
        const headers = this.parseHeaders(headerText);

        // Process based on path
        if (headers['Path'] === 'audio') {
            // Extract audio data after header
            const audioData = view.slice(2 + headerLength);

            if (audioData.length > 0) {
                //ztoolkit.log(`Received audio chunk: ${audioData.length} bytes`);
                try {
                    await this.audioPlayer.queueAudioChunk(audioData);
                } catch (error) {
                    ztoolkit.log(`Error queueing audio chunk: ${error}`);
                }
            }
        } else if (headers['Path'] === 'response') {
            // Extract and log response metadata
            const bodyStart = 2 + headerLength;
            if (bodyStart < view.length) {
                const bodyText = new TextDecoder('utf-8').decode(view.slice(bodyStart));
                ztoolkit.log(`Response: ${bodyText}`);
            }
        }
    }

    private parseHeaders(headerText: string): { [key: string]: string } {
        const headers: { [key: string]: string } = {};
        const lines = headerText.split('\r\n');

        for (const line of lines) {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.substring(0, colonIndex).trim();
                const value = line.substring(colonIndex + 1).trim();
                headers[key] = value;
            }
        }

        return headers;
    }
}

// Azure accepts speaking rates between half and double speed
const MIN_RATE_PERCENT = 50;
const MAX_RATE_PERCENT = 200;

function escapeXml(text: string): string {
    return text
        // Characters that XML 1.0 does not allow, for example from PDF extraction
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, " ")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function buildSsml(text: string, voiceName: string, languageId: string, ratePercent: number): string {
    const clamped = Math.min(MAX_RATE_PERCENT, Math.max(MIN_RATE_PERCENT, Math.round(ratePercent)));
    if (clamped !== ratePercent) {
        ztoolkit.log(`Azure rate ${ratePercent}% is outside ${MIN_RATE_PERCENT}-${MAX_RATE_PERCENT}%, using ${clamped}%`);
    }
    const relative = clamped - 100;
    const rate = `${relative >= 0 ? "+" : ""}${relative}%`;

    let content = `<prosody rate="${rate}">${escapeXml(text)}</prosody>`;
    // A multilingual voice speaks another of its languages only inside <lang>
    const voiceLocale = voiceName.split("-").slice(0, 2).join("-");
    if (voiceLocale.toLowerCase() !== languageId.toLowerCase()) {
        content = `<lang xml:lang="${escapeXml(languageId)}">${content}</lang>`;
    }

    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(languageId)}">`
        + `<voice name="${escapeXml(voiceName)}">${content}</voice></speak>`;
}

// Singleton instance management
let synthesizer: AzureStreamingSynthesizer | null = null;

function getSynthesizer(): AzureStreamingSynthesizer {
    if (!synthesizer) {
        synthesizer = new AzureStreamingSynthesizer();
    }
    return synthesizer;
}

function setDefaultPrefs(): void {
    if (!getPref("azure.subscriptionKey")) {
        setPref("azure.subscriptionKey", "");
    }

    if (!getPref("azure.region")) {
        setPref("azure.region", "");
    }

    if (!getPref("azure.language")) {
        setPref("azure.language", "en-US");
    }

    // No default voice - user must select after fetching from API
}

async function initEngine(): Promise<void> {
    // Azure engine initialization always succeeds
    // Actual validation happens when user tries to speak
    // This allows users to configure the engine after installation
    return Promise.resolve();
}

// Get Azure configuration from environment variables and preferences
// Preferences override environment variables
function getAzureConfig(): { key: string; region: string } {
    let subscriptionKey = "";
    let region = "";

    // Try environment variables first
    try {
        // @ts-ignore - nsIEnvironment not in type definitions
        const env = Components.classes["@mozilla.org/process/environment;1"]
            .getService(Components.interfaces.nsIEnvironment);
        if (env.exists("AZURE_SPEECH_KEY")) {
            subscriptionKey = env.get("AZURE_SPEECH_KEY");
        }
        if (env.exists("AZURE_SPEECH_REGION")) {
            region = env.get("AZURE_SPEECH_REGION");
        }
    } catch (error) {
        ztoolkit.log(`Failed to read Azure environment variables: ${error}`);
    }

    // Preferences override environment variables
    const prefKey = (getPref("azure.subscriptionKey") as string || "").trim();
    if (prefKey) {
        subscriptionKey = prefKey;
    }

    const prefRegion = (getPref("azure.region") as string || "").trim();
    if (prefRegion) {
        region = prefRegion;
    }

    return {
        key: subscriptionKey.trim(),
        region: region.trim().toLowerCase()
    };
}

// Exported functions matching webSpeech.ts pattern
function speak(text: string): void {
    const synth = getSynthesizer();

    synth.speak(text).catch((error) => {
        ztoolkit.log(`Azure TTS error: ${error}`);

        let errorKey = "other";
        if (error.message === "config-incomplete") {
            errorKey = "config-incomplete";
        } else if (error.message === "auth-failed") {
            errorKey = "auth-failed";
        } else if (error.message === "connection-failed") {
            errorKey = "connection-failed";
        } else if (error.message === "playback-unsupported") {
            errorKey = "playback-unsupported";
        }

        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: "azure" } }),
             getString("popup-engineErrorCause", { args: { engine: "azure", cause: errorKey } })],
            "error"
        );

        addon.data.tts.state = "idle";
    });
}

function stop(): void {
    if (synthesizer) {
        synthesizer.stop();
    }
}

function pause(): void {
    if (synthesizer) {
        synthesizer.pause();
    }
}

function resume(): void {
    if (synthesizer) {
        synthesizer.resume();
    }
}

function resetConnection(): void {
    if (synthesizer) {
        synthesizer.disconnect();
    }
}

function dispose(): void {
    if (synthesizer) {
        synthesizer.dispose();
        synthesizer = null;
    }
}

// Extras for preferences UI
async function getAllVoices(): Promise<{ success: boolean; voices: AzureVoice[] }> {
    const { key: subscriptionKey, region } = getAzureConfig();

    if (!subscriptionKey || !region) {
        ztoolkit.log("No subscription key or region available");
        return { success: false, voices: [] };
    }

    try {
        const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Ocp-Apim-Subscription-Key': subscriptionKey
            }
        });

        if (!response.ok) {
            ztoolkit.log(`Failed to fetch voices: ${response.status} ${response.statusText}`);
            return { success: false, voices: [] };
        }

        const voices = await response.json();

        if (!Array.isArray(voices)) {
            ztoolkit.log("Invalid response format from Azure voices API");
            return { success: false, voices: [] };
        }

        return { success: true, voices: voices };

    } catch (error) {
        ztoolkit.log(`Error fetching voices from Azure: ${error}\n  URL: https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list\n  Region: ${region}\n  Key length: ${subscriptionKey.length}`);
        return { success: false, voices: [] };
    }
}

function extractLanguages(voices: AzureVoice[]): string[] {
    const languageSet = new Set<string>();

    voices.forEach(voice => {
        if (voice.Locale) {
            languageSet.add(voice.Locale);
        }

        if (voice.SecondaryLocaleList && Array.isArray(voice.SecondaryLocaleList)) {
            voice.SecondaryLocaleList.forEach((lang: string) => {
                languageSet.add(lang);
            });
        }
    });

    return Array.from(languageSet).sort();
}

function filterVoicesByLanguage(voices: AzureVoice[], language: string): string[] {
    const filtered = voices.filter(voice => {
        if (voice.Locale === language) {
            return true;
        }

        if (voice.SecondaryLocaleList && Array.isArray(voice.SecondaryLocaleList)) {
            return voice.SecondaryLocaleList.includes(language);
        }

        return false;
    });

    return filtered
        .map(voice => voice.ShortName)
        .filter(name => name) // Filter out any undefined/null
        .sort();
}

export {
    // Lifecycle
    setDefaultPrefs,
    initEngine,

    // TTS Operations
    speak,
    stop,
    pause,
    resume,

    // Connection & Resource Management
    resetConnection,
    dispose,

    // Configuration & Utilities
    getAzureConfig,
    getAllVoices,
    extractLanguages,
    filterVoicesByLanguage
};
