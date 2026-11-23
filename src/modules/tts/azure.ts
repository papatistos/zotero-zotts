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

// Audio player that streams Azure's WebM/Opus output into one MediaSource.
// Playing every few kilobytes as a separate Ogg file left an audible gap at
// each file switch. One continuous stream has no switches, and the audio
// element keeps the pitch when the playback rate is changed.
class AudioPlayer {
    private static readonly MIME_TYPE = 'audio/webm; codecs="opus"';

    private audioElement: HTMLAudioElement | null = null;
    private mediaSource: MediaSource | null = null;
    private sourceBuffer: SourceBuffer | null = null;
    private objectUrl: string | null = null;
    private cancelSourceOpen: (() => void) | null = null;
    private pendingChunks: Uint8Array[] = [];
    private receivedBytes: number = 0;
    private hasStarted: boolean = false;
    private isPaused: boolean = false;
    private isSynthesisComplete: boolean = false;
    // Incremented on every reset so callbacks from an old stream are ignored
    private generation: number = 0;
    private onAllSegmentsComplete?: () => void;

    // Bytes to receive before playback starts (the "Playback Preload Amount")
    private _minSegmentSize: number = 8 * 1024;

    public get minSegmentSize(): number {
        return this._minSegmentSize;
    }

    public set minSegmentSize(size: number) {
        this._minSegmentSize = size;
    }

    public async initialize(): Promise<void> {
        if (!this.audioElement) {
            this.audioElement = new window.Audio();
            this.audioElement.autoplay = false;
        }
    }

    public setOnCompleteCallback(callback: () => void): void {
        this.onAllSegmentsComplete = callback;
    }

    // Open a fresh MediaSource for one synthesis turn. Resolves once it accepts data.
    public async startStream(): Promise<void> {
        await this.initialize();
        this.resetAudioState();
        const generation = this.generation;

        const MediaSourceClass = window.MediaSource;
        if (!MediaSourceClass || !MediaSourceClass.isTypeSupported(AudioPlayer.MIME_TYPE)) {
            ztoolkit.log(`MediaSource does not support ${AudioPlayer.MIME_TYPE}`);
            throw new Error("playback-unsupported");
        }

        const audio = this.audioElement!;
        const mediaSource = new MediaSourceClass();
        this.mediaSource = mediaSource;
        this.objectUrl = URL.createObjectURL(mediaSource);
        audio.onended = () => this.onMediaEnded(generation);
        audio.onerror = () => this.onMediaError(generation, `media error code ${audio.error?.code}`);

        await new Promise<void>((resolve) => {
            this.cancelSourceOpen = resolve;
            mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
            audio.src = this.objectUrl!;
        });
        this.cancelSourceOpen = null;

        if (generation !== this.generation) {
            return; // Stopped while the MediaSource was opening
        }

        const sourceBuffer = mediaSource.addSourceBuffer(AudioPlayer.MIME_TYPE);
        sourceBuffer.addEventListener("updateend", () => {
            if (generation === this.generation) {
                this.flush();
            }
        });
        sourceBuffer.addEventListener("error", () => this.onMediaError(generation, "source buffer error"));
        this.sourceBuffer = sourceBuffer;
        this.flush();
    }

    public async queueAudioChunk(audioData: Uint8Array): Promise<void> {
        this.pendingChunks.push(audioData);
        this.receivedBytes += audioData.length;
        this.flush();
        this.maybeStartPlayback();
    }

    public async onSynthesisComplete(): Promise<void> {
        this.isSynthesisComplete = true;
        ztoolkit.log(`onSynthesisComplete: received ${this.receivedBytes} bytes`);

        if (this.receivedBytes === 0) {
            // Nothing to play, so no "ended" event will come
            this.onMediaEnded(this.generation);
            return;
        }

        this.flush();
        this.maybeStartPlayback();
    }

    public pause(): void {
        if (this.isPaused || addon.data.tts.state === "idle") {
            return;
        }
        if (this.audioElement && this.hasStarted) {
            this.audioElement.pause();
        }
        this.isPaused = true;
        addon.data.tts.state = "paused";
    }

    public resume(): void {
        if (!this.isPaused) {
            return;
        }
        this.isPaused = false;
        addon.data.tts.state = "playing";

        if (this.hasStarted && this.audioElement) {
            this.audioElement.play()?.catch((error) =>
                this.onMediaError(this.generation, `resume failed: ${error}`));
        } else {
            this.maybeStartPlayback();
        }
    }

    public stop(): void {
        this.resetAudioState();
        this.isPaused = false;
        addon.data.tts.state = "idle";
    }

    public dispose(): void {
        this.stop();
        this.audioElement = null;
    }

    // Append queued chunks one at a time; SourceBuffer accepts no new data while updating
    private flush(): void {
        const sourceBuffer = this.sourceBuffer;
        const mediaSource = this.mediaSource;
        if (!sourceBuffer || !mediaSource || sourceBuffer.updating || mediaSource.readyState !== "open") {
            return;
        }

        if (this.pendingChunks.length > 0) {
            const data = concatChunks(this.pendingChunks);
            this.pendingChunks = [];
            try {
                sourceBuffer.appendBuffer(data);
            } catch (error) {
                this.onMediaError(this.generation, `appendBuffer failed: ${error}`);
            }
            return;
        }

        if (this.isSynthesisComplete) {
            try {
                mediaSource.endOfStream();
            } catch (error) {
                ztoolkit.log(`endOfStream failed: ${error}`);
            }
        }
    }

    private maybeStartPlayback(): void {
        if (this.hasStarted || this.isPaused || !this.audioElement || !this.objectUrl) {
            return;
        }
        if (this.receivedBytes < this.minSegmentSize && !this.isSynthesisComplete) {
            return;
        }

        this.hasStarted = true;
        const audio = this.audioElement;
        const generation = this.generation;

        // Set after the src is assigned, because loading a new src resets playbackRate
        const rate = (getPref("azure.rate") as number) / 100;
        audio.volume = (getPref("azure.volume") as number) / 100;
        (audio as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
        audio.defaultPlaybackRate = rate;
        audio.playbackRate = rate;

        ztoolkit.log(`Starting playback after ${this.receivedBytes} bytes`);
        audio.play()?.catch((error) => this.onMediaError(generation, `play failed: ${error}`));
    }

    private onMediaEnded(generation: number): void {
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

    private onMediaError(generation: number, message: string): void {
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

        if (this.cancelSourceOpen) {
            this.cancelSourceOpen();
            this.cancelSourceOpen = null;
        }

        this.pendingChunks = [];
        this.receivedBytes = 0;
        this.hasStarted = false;
        this.isSynthesisComplete = false;
        this.sourceBuffer = null;
        this.mediaSource = null;

        if (this.audioElement) {
            this.audioElement.onended = null;
            this.audioElement.onerror = null;
            if (!this.audioElement.paused) {
                this.audioElement.pause();
            }
            if (this.audioElement.src) {
                this.audioElement.removeAttribute("src");
                this.audioElement.load();
            }
        }

        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
    }
    return data;
}

// WebSocket v2 connection manager for Azure Speech
class AzureStreamingSynthesizer {
    private static readonly TURN_START_TIMEOUT = 5000;

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
        let wsUrl = `wss://${region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2`;
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
        const minSegmentSizeKB = getPref("azure.minSegmentSize") as number || 8;
        this.audioPlayer.minSegmentSize = minSegmentSizeKB * 1024;

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
        const configMessage = this.buildMessage('speech.config', {});
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
                    outputFormat: 'webm-24khz-16bit-mono-opus'
                },
                language: {
                    autoDetection: false
                },
                input: {
                    bidirectionalStreamingMode: true,
                    voiceName: voiceName,
                    language: languageId
                }
            }
        });

        // Wait for turn.start response
        const turnStartPromise = new Promise<void>((resolve, reject) => {
            this.turnStartResolve = resolve;
            this.turnStartReject = reject;
        });

        this.ws?.send(contextMessage);

        try {
            await Promise.race([
                turnStartPromise,
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error("Timeout waiting for turn.start")), AzureStreamingSynthesizer.TURN_START_TIMEOUT)
                )
            ]);

            // Check if cancelled during wait
            if (this.isStopped) {
                ztoolkit.log("Synthesis cancelled while waiting for turn.start");
                return;
            }
        } catch (error) {
            ztoolkit.log(`Error waiting for turn.start: ${error}`);
            throw error;
        }

        // Check if stopped after waiting for turn.start
        if (this.isStopped) {
            return;
        }

        // Send section text
        ztoolkit.log(`Sending section text: ${sectionText.length} characters`);
        addon.data.tts.state = "playing";

        const textMessage = this.buildMessage('text.piece', sectionText, 'text/plain');
        this.ws?.send(textMessage);

        // Immediately send text.end to signal completion
        const endMessage = this.buildMessage('text.end', '', 'text/plain');
        this.ws?.send(endMessage);

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

        // For text/plain messages, body is already a string; for JSON messages, stringify it
        const content = contentType === 'text/plain' ? body : JSON.stringify(body);
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
