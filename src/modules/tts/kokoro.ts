/**
 * Kokoro TTS Engine
 *
 * Dedicated engine for Kokoro TTS (kokoro-web / Kokoro-FastAPI).
 * Similar to the Local TTS engine but with API discovery for models, voices, and languages.
 * Dropdowns in preferences are populated dynamically from the Kokoro API.
 */

import { getPref, setPref } from "../utils/prefs";
import { notifyGeneric } from "../utils/notify";
import { getString } from "../utils/locale";
import { playQueuedSpeechCue } from "../utils/audioCue";

// Error codes for Kokoro TTS
const ErrorCodes = {
    CONFIG_INCOMPLETE: "config-incomplete",
    AUTH_FAILED: "auth-failed",
    CONNECTION_FAILED: "connection-failed",
    RATE_LIMITED: "rate-limited",
    API_ERROR: "api-error"
} as const;

// Get AbortController from window object
const AbortController = window.AbortController;

function createAbortError(message: string): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

/**
 * Get configuration for Kokoro API
 */
function getKokoroConfig(): { apiUrl: string } {
    const apiUrl = (getPref("kokoro.apiUrl") as string || "").trim();
    return { apiUrl };
}

/**
 * Set default preferences for Kokoro TTS
 */
function setDefaultPrefs(): void {
    if (!getPref("kokoro.apiUrl")) {
        setPref("kokoro.apiUrl", "");
    }

    if (!getPref("kokoro.model")) {
        setPref("kokoro.model", "model");
    }

    if (!getPref("kokoro.voice")) {
        setPref("kokoro.voice", "");
    }

    if (!getPref("kokoro.language")) {
        setPref("kokoro.language", "");
    }

    if (!getPref("kokoro.volume")) {
        setPref("kokoro.volume", 100);
    }

    if (!getPref("kokoro.rate")) {
        setPref("kokoro.rate", 100);
    }
}

/**
 * Initialize the Kokoro TTS engine
 */
async function initEngine(): Promise<void> {
    // Kokoro engine initialization always succeeds
    // Actual validation happens when user tries to speak
    return Promise.resolve();
}

// ============================================================================
// API Discovery Functions
// ============================================================================

/**
 * Fetch available models from the Kokoro API
 */
async function fetchModels(apiUrl: string): Promise<{ success: boolean; models: any[] }> {
    if (!apiUrl) return { success: false, models: [] };

    try {
        const response = await fetch(`${apiUrl}/v1/audio/models`, {
            method: "GET",
            headers: { "Accept": "application/json" },
        });

        if (!response.ok) {
            ztoolkit.log(`Kokoro fetchModels error: ${response.status}`);
            return { success: false, models: [] };
        }

        const data: any = await response.json();
        // API may return an array directly or an object with a "models" or "data" field
        const models = Array.isArray(data) ? data : (data.models || data.data || []);
        return { success: true, models };
    } catch (error) {
        ztoolkit.log(`Kokoro fetchModels network error: ${error}`);
        return { success: false, models: [] };
    }
}

/**
 * Fetch available voices from the Kokoro API
 */
async function fetchVoices(apiUrl: string): Promise<{ success: boolean; voices: any[] }> {
    if (!apiUrl) return { success: false, voices: [] };

    try {
        const response = await fetch(`${apiUrl}/v1/audio/voices`, {
            method: "GET",
            headers: { "Accept": "application/json" },
        });

        if (!response.ok) {
            ztoolkit.log(`Kokoro fetchVoices error: ${response.status}`);
            return { success: false, voices: [] };
        }

        const data: any = await response.json();
        const voices = Array.isArray(data) ? data : (data.voices || data.data || []);
        return { success: true, voices };
    } catch (error) {
        ztoolkit.log(`Kokoro fetchVoices network error: ${error}`);
        return { success: false, voices: [] };
    }
}

/**
 * Fetch available languages from the Kokoro API
 */
async function fetchLangs(apiUrl: string): Promise<{ success: boolean; langs: any[] }> {
    if (!apiUrl) return { success: false, langs: [] };

    try {
        const response = await fetch(`${apiUrl}/v1/audio/langs`, {
            method: "GET",
            headers: { "Accept": "application/json" },
        });

        if (!response.ok) {
            ztoolkit.log(`Kokoro fetchLangs error: ${response.status}`);
            return { success: false, langs: [] };
        }

        const data: any = await response.json();
        const langs = Array.isArray(data) ? data : (data.langs || data.languages || data.data || []);
        return { success: true, langs };
    } catch (error) {
        ztoolkit.log(`Kokoro fetchLangs network error: ${error}`);
        return { success: false, langs: [] };
    }
}

// ============================================================================
// Audio Player - Handles MP3 playback
// ============================================================================

class AudioPlayer {
    private audioElement: HTMLAudioElement | null = null;
    private isPlaying: boolean = false;
    private isPaused: boolean = false;
    private isInitialized: boolean = false;
    private onComplete?: () => void;
    private currentBlobUrl: string | null = null;

    public async initialize(): Promise<void> {
        if (this.isInitialized) return;
        this.audioElement = new window.Audio();
        this.audioElement.autoplay = false;
        this.isInitialized = true;
    }

    public setOnCompleteCallback(callback: () => void): void {
        this.onComplete = callback;
    }

    public prepareForNewSection(): void {
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.currentTime = 0;
            this.isPlaying = false;
            this.isPaused = false;
            if (this.currentBlobUrl) {
                URL.revokeObjectURL(this.currentBlobUrl);
                this.currentBlobUrl = null;
            }
        }
    }

    public async playAudio(audioBlob: Blob): Promise<void> {
        if (!this.isInitialized) await this.initialize();

        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
        }

        this.isPlaying = true;
        addon.data.tts.state = "playing";

        const url = URL.createObjectURL(audioBlob);
        this.currentBlobUrl = url;

        if (this.audioElement) {
            this.audioElement.src = url;
            this.audioElement.volume = (getPref("kokoro.volume") as number) / 100;
            // Speed is handled server-side via the API speed parameter
            // (avoids pitch distortion from client-side playbackRate)

            const playPromise = this.audioElement.play();
            if (playPromise !== undefined) {
                playPromise.catch((error) => {
                    ztoolkit.log(`Audio playback error: ${error}`);
                    this.isPlaying = false;
                    URL.revokeObjectURL(url);
                    this.currentBlobUrl = null;
                });
            }

            this.audioElement.onended = () => {
                URL.revokeObjectURL(url);
                this.currentBlobUrl = null;
                this.isPlaying = false;
                if (this.onComplete) {
                    this.onComplete();
                }
            };
        }
    }

    public pause(): void {
        if (this.audioElement && this.isPlaying) {
            this.audioElement.pause();
            this.isPaused = true;
            addon.data.tts.state = "paused";
        }
    }

    public resume(): void {
        if (this.audioElement && this.isPaused) {
            this.audioElement.play();
            this.isPaused = false;
            addon.data.tts.state = "playing";
        }
    }

    public getCurrentTime(): number {
        return this.audioElement?.currentTime || 0;
    }

    public skipBackward(seconds: number = 10): void {
        if (this.audioElement && this.isInitialized) {
            this.audioElement.currentTime = Math.max(0, this.audioElement.currentTime - seconds);
        }
    }

    public skipForward(seconds: number = 10): void {
        if (this.audioElement && this.isInitialized) {
            const newTime = this.audioElement.currentTime + seconds;
            if (newTime < this.audioElement.duration) {
                this.audioElement.currentTime = newTime;
            }
        }
    }

    public stop(): void {
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.currentTime = 0;
            this.isPlaying = false;
            this.isPaused = false;
            if (this.currentBlobUrl) {
                URL.revokeObjectURL(this.currentBlobUrl);
                this.currentBlobUrl = null;
            }
        }
    }

    public dispose(): void {
        this.stop();
        if (this.audioElement) {
            this.audioElement.src = "";
            this.audioElement = null;
        }
        this.isInitialized = false;
    }
}

// ============================================================================
// Text Section Splitter - Splits long text into manageable chunks
// ============================================================================

class TextSectionSplitter {
    private static readonly MAX_SECTION_SIZE = 4096;
    // Kokoro effectively buffers a whole section before returning audio.
    // Give section 1 enough spoken duration to hide synthesis of section 2,
    // then keep later sections smaller so the single in-flight prefetch can
    // stay ahead without reintroducing long startup latency.
    private static readonly FIRST_SECTION_SIZE = 160;
    private static readonly STANDARD_SECTION_SIZE = 280;
    private static readonly SENTENCE_ADJUSTMENT_LIMIT = 60;

    private fullText: string = "";
    private currentIndex: number = 0;
    private isFirstSection: boolean = true;

    public initialize(text: string): void {
        this.fullText = text;
        this.currentIndex = 0;
        this.isFirstSection = true;
    }

    public hasMore(): boolean {
        return this.currentIndex < this.fullText.length;
    }

    public getNextSection(): string {
        if (!this.hasMore()) return "";

        const targetSize = this.isFirstSection
            ? TextSectionSplitter.FIRST_SECTION_SIZE
            : TextSectionSplitter.STANDARD_SECTION_SIZE;

        const remaining = this.fullText.length - this.currentIndex;

        let sectionEnd: number;
        if (remaining <= targetSize + TextSectionSplitter.SENTENCE_ADJUSTMENT_LIMIT) {
            sectionEnd = this.fullText.length;
        } else {
            sectionEnd = this.findBreakPoint(this.currentIndex, targetSize);
        }

        const section = this.fullText.substring(this.currentIndex, sectionEnd);
        this.currentIndex = sectionEnd;
        this.isFirstSection = false;

        return section;
    }

    public reset(): void {
        this.fullText = "";
        this.currentIndex = 0;
        this.isFirstSection = true;
    }

    private findBreakPoint(startIndex: number, targetSize: number): number {
        const maxEnd = Math.min(this.fullText.length, startIndex + TextSectionSplitter.MAX_SECTION_SIZE);
        const baseSearchEnd = Math.min(startIndex + targetSize, maxEnd);
        const searchText = this.fullText.substring(startIndex, baseSearchEnd);

        // Try to find sentence boundaries
        const breakPatterns = [/[.!?]\s/g, /\n\n/g, /\n/g, /,\s/g, /\s/g];

        for (const pattern of breakPatterns) {
            pattern.lastIndex = 0;
            let lastMatch: RegExpExecArray | null = null;
            let match: RegExpExecArray | null;

            while ((match = pattern.exec(searchText)) !== null) {
                if (match.index > targetSize * 0.5) {
                    lastMatch = match;
                }
            }

            if (lastMatch) {
                return startIndex + lastMatch.index + lastMatch[0].length;
            }
        }

        return baseSearchEnd;
    }
}

// ============================================================================
// Session Cache - Stores audio for replay
// ============================================================================

interface SessionCache {
    text: string;
    apiUrl: string;
    model: string;
    rate: number;
    voice: string;
    sections: Blob[];
}

interface QueuedAudio {
    blob: Blob;
    section: string;
    index: number;
}

// ============================================================================
// Kokoro TTS Synthesizer
// ============================================================================

class KokoroSynthesizer {
    private audioPlayer: AudioPlayer;
    private textSplitter: TextSectionSplitter;
    private isStopped: boolean = false;
    private activeAbortControllers: Set<AbortController> = new Set();
    private activeSessionId: number = 0;

    private audioQueue: QueuedAudio[] = [];
    private prefetchInProgress: Set<number> = new Set();
    private readonly MAX_PREFETCH = 1;

    private sessionCache: SessionCache | null = null;
    private currentSectionIndex: number = -1;
    private nextCachedPlaybackIndex: number = 0;
    private nextSectionIndex: number = 0;
    private cachePlaybackActive: boolean = false;
    private waitingForPrefetch: boolean = false;

    constructor() {
        this.audioPlayer = new AudioPlayer();
        this.textSplitter = new TextSectionSplitter();
        this.audioPlayer.setOnCompleteCallback(() => this.onAudioComplete());
    }

    public async speak(text: string): Promise<void> {
        this.invalidateActiveSession();
        this.audioPlayer.stop();
        this.clearQueue();

        this.currentSectionIndex = -1;
        this.nextCachedPlaybackIndex = 0;
        this.nextSectionIndex = 0;
        this.cachePlaybackActive = false;
        this.waitingForPrefetch = false;

        const { apiUrl } = getKokoroConfig();
        const model = (getPref("kokoro.model") as string) || "model";
        const rate = (getPref("kokoro.rate") as number) || 100;
        const voice = getPref("kokoro.voice") as string || "";
        const sessionId = this.activeSessionId;

        // Check cache
        if (this.sessionCache?.text === text &&
            this.sessionCache?.apiUrl === apiUrl &&
            this.sessionCache?.model === model &&
            this.sessionCache?.rate === rate &&
            this.sessionCache?.voice === voice) {
            ztoolkit.log(`Playing from cache: ${this.sessionCache.sections.length} sections`);
            this.isStopped = false;
            await this.playCachedSection();
            return;
        }

        this.sessionCache = { text, apiUrl, model, rate, voice, sections: [] };
        this.textSplitter.initialize(text);
        this.isStopped = false;

        const firstSection = this.textSplitter.getNextSection();
        const firstIndex = this.nextSectionIndex++;

        ztoolkit.log(`Kokoro speak: ${text.length} chars, first section ${firstSection.length} chars`);

        // Send ONLY the first section — don't prefetch yet.
        // Kokoro is single-threaded; concurrent requests would queue and
        // delay the first section's response.
        playQueuedSpeechCue();
        await this.speakSection(firstSection, firstIndex, sessionId);

        // Now that the first section is playing, prefetch the next one
        if (sessionId === this.activeSessionId && this.textSplitter.hasMore() && !this.isStopped) {
            this.startPrefetching(sessionId);
        }
    }

    private async speakSection(sectionText: string, sectionIndex: number, sessionId: number): Promise<void> {
        if (this.isStopped || sessionId !== this.activeSessionId) return;

        this.audioPlayer.prepareForNewSection();
        await this.audioPlayer.initialize();

        try {
            const audioBlob = await this.synthesizeToBlob(sectionText, sessionId);
            ztoolkit.log(`Received audio: ${audioBlob.size} bytes`);

            if (sessionId !== this.activeSessionId || this.isStopped) {
                return;
            }

            if (this.sessionCache) {
                this.sessionCache.sections[sectionIndex] = audioBlob;
            }

            if (this.isStopped || sessionId !== this.activeSessionId) return;

            this.currentSectionIndex = sectionIndex;
            await this.audioPlayer.playAudio(audioBlob);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                ztoolkit.log('Kokoro request aborted');
                return;
            }
            throw error;
        }
    }

    private startPrefetching(sessionId: number): void {
        if (sessionId !== this.activeSessionId) {
            return;
        }

        const sectionsToFetch = Math.min(
            this.MAX_PREFETCH - this.audioQueue.length - this.prefetchInProgress.size,
            this.MAX_PREFETCH
        );

        for (let i = 0; i < sectionsToFetch && this.textSplitter.hasMore(); i++) {
            const sectionIndex = this.nextSectionIndex++;

            if (!this.prefetchInProgress.has(sectionIndex)) {
                this.prefetchInProgress.add(sectionIndex);
                const section = this.textSplitter.getNextSection();

                ztoolkit.log(`Prefetching section ${sectionIndex}: ${section.length} chars`);

                this.fetchSection(section, sectionIndex, sessionId).catch((error) => {
                    ztoolkit.log(`Prefetch error: ${error}`);
                    this.prefetchInProgress.delete(sectionIndex);
                });
            }
        }
    }

    private async fetchSection(sectionText: string, sectionIndex: number, sessionId: number): Promise<void> {
        if (this.isStopped || sessionId !== this.activeSessionId) {
            this.prefetchInProgress.delete(sectionIndex);
            return;
        }

        try {
            const audioBlob = await this.synthesizeToBlob(sectionText, sessionId);

            if (sessionId !== this.activeSessionId || this.isStopped) {
                this.prefetchInProgress.delete(sectionIndex);
                return;
            }

            if (this.sessionCache) {
                this.sessionCache.sections[sectionIndex] = audioBlob;
            }

            if (this.isStopped || sessionId !== this.activeSessionId) {
                this.prefetchInProgress.delete(sectionIndex);
                return;
            }

            this.audioQueue.push({ blob: audioBlob, section: sectionText, index: sectionIndex });
            ztoolkit.log(`Prefetched section ${sectionIndex}, queue size: ${this.audioQueue.length}`);
            this.prefetchInProgress.delete(sectionIndex);

            // If the player was waiting for this prefetch, resume playback
            if (this.waitingForPrefetch) {
                this.waitingForPrefetch = false;
                this.onAudioComplete();
            }
        } catch (error) {
            this.prefetchInProgress.delete(sectionIndex);
            throw error;
        }
    }

    private onAudioComplete(): void {
        if (this.isStopped) {
            this.textSplitter.reset();
            addon.data.tts.state = "idle";
            return;
        }

        // Playing from cache
        if (this.cachePlaybackActive && this.sessionCache &&
            this.nextCachedPlaybackIndex < this.sessionCache.sections.length) {
            ztoolkit.log(`Continuing cached playback: section ${this.nextCachedPlaybackIndex}`);
            this.playCachedSection();
            return;
        } else if (this.cachePlaybackActive) {
            this.cachePlaybackActive = false;
        }

        // Check prefetch queue
        if (this.audioQueue.length > 0) {
            const queued = this.audioQueue.shift()!;
            ztoolkit.log(`Playing queued audio: section ${queued.index}`);

            if (this.textSplitter.hasMore()) {
                this.startPrefetching(this.activeSessionId);
            }

            this.currentSectionIndex = queued.index;
            this.audioPlayer.playAudio(queued.blob);
            return;
        }

        // Prefetch is still in-flight — wait for it to arrive
        if (this.prefetchInProgress.size > 0) {
            ztoolkit.log(`Waiting for ${this.prefetchInProgress.size} in-flight prefetch(es)`);
            this.waitingForPrefetch = true;
            return;
        }

        // Synthesize more
        if (this.textSplitter.hasMore()) {
            const nextSection = this.textSplitter.getNextSection();
            const nextIndex = this.nextSectionIndex++;
            ztoolkit.log(`Fetching next section: ${nextSection.length} chars`);

            this.speakSection(nextSection, nextIndex, this.activeSessionId).catch((error) => {
                ztoolkit.log(`Error synthesizing: ${error}`);
                this.textSplitter.reset();
                addon.data.tts.state = "idle";
            });
        } else {
            ztoolkit.log('All sections completed');
            this.textSplitter.reset();
            addon.data.tts.state = "idle";
        }
    }

    private async synthesizeToBlob(sectionText: string, sessionId: number): Promise<Blob> {
        const { apiUrl } = getKokoroConfig();
        const voice = getPref("kokoro.voice") as string || "";

        if (!apiUrl) {
            throw new Error(ErrorCodes.CONFIG_INCOMPLETE);
        }

        const controller = new AbortController();
        this.activeAbortControllers.add(controller);

        try {
            if (this.isStopped || sessionId !== this.activeSessionId) {
                throw createAbortError("Kokoro request invalidated before fetch");
            }

            const response = await fetch(`${apiUrl}/v1/audio/speech`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: (getPref("kokoro.model") as string) || "model",
                    input: sectionText,
                    voice: voice,
                    response_format: "wav",
                    speed: (getPref("kokoro.rate") as number || 100) / 100,
                }),
                signal: controller.signal,
            });

            if (this.isStopped || sessionId !== this.activeSessionId) {
                throw createAbortError("Kokoro request invalidated after fetch");
            }

            if (!response.ok) {
                const errorText = await response.text();
                ztoolkit.log(`Kokoro TTS API error: ${response.status} - ${errorText}`);

                if (response.status === 401) throw new Error(ErrorCodes.AUTH_FAILED);
                if (response.status === 429) throw new Error(ErrorCodes.RATE_LIMITED);
                throw new Error(ErrorCodes.API_ERROR);
            }

            const audioBlob = await response.blob();

            if (this.isStopped || sessionId !== this.activeSessionId) {
                throw createAbortError("Kokoro request invalidated after blob conversion");
            }

            return audioBlob;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            if (error instanceof Error && Object.values(ErrorCodes).includes(error.message as any)) throw error;

            ztoolkit.log(`Kokoro TTS network error: ${error}`);
            throw new Error(ErrorCodes.CONNECTION_FAILED);
        } finally {
            this.activeAbortControllers.delete(controller);
        }
    }

    private clearQueue(): void {
        this.audioQueue = [];
        this.prefetchInProgress.clear();
        this.waitingForPrefetch = false;
    }

    private invalidateActiveSession(): void {
        this.activeSessionId++;
        for (const controller of this.activeAbortControllers) {
            controller.abort();
        }
        this.activeAbortControllers.clear();
    }

    private async playCachedSection(startIndex?: number): Promise<void> {
        if (!this.sessionCache || this.sessionCache.sections.length === 0) {
            this.cachePlaybackActive = false;
            addon.data.tts.state = "idle";
            return;
        }

        if (typeof startIndex === "number") {
            this.nextCachedPlaybackIndex = Math.max(0, Math.min(startIndex, this.sessionCache.sections.length - 1));
        }

        if (this.nextCachedPlaybackIndex >= this.sessionCache.sections.length) {
            this.cachePlaybackActive = false;
            addon.data.tts.state = "idle";
            return;
        }

        const audioBlob = this.sessionCache.sections[this.nextCachedPlaybackIndex];
        if (!audioBlob) {
            this.cachePlaybackActive = false;
            addon.data.tts.state = "idle";
            return;
        }

        this.currentSectionIndex = this.nextCachedPlaybackIndex;
        this.nextCachedPlaybackIndex++;
        this.cachePlaybackActive = true;

        await this.audioPlayer.playAudio(audioBlob);
    }

    public stop(): void {
        this.invalidateActiveSession();
        this.isStopped = true;
        this.cachePlaybackActive = false;
        this.waitingForPrefetch = false;
        this.clearQueue();
        this.textSplitter.reset();
        this.audioPlayer.stop();
        addon.data.tts.state = "idle";
    }

    public pause(): void { this.audioPlayer.pause(); }
    public resume(): void { this.audioPlayer.resume(); }

    public skipBackward(): void {
        const currentTime = this.audioPlayer.getCurrentTime();
        if (currentTime >= 10) {
            this.audioPlayer.skipBackward(10);
            return;
        }

        if (this.sessionCache && this.currentSectionIndex > 0) {
            const prevIndex = this.currentSectionIndex - 1;
            if (this.sessionCache.sections[prevIndex]) {
                this.audioPlayer.stop();
                this.isStopped = false;
                this.playCachedSection(prevIndex);
                return;
            }
        }
        this.audioPlayer.skipBackward(10);
    }

    public skipForward(): void { this.audioPlayer.skipForward(10); }

    public async replaySection(): Promise<void> {
        if (this.sessionCache?.sections.length) {
            this.audioPlayer.stop();
            this.currentSectionIndex = -1;
            this.nextCachedPlaybackIndex = 0;
            this.isStopped = false;
            await this.playCachedSection();
        }
    }

    public dispose(): void {
        this.stop();
        this.audioPlayer.dispose();
    }
}

// ============================================================================
// Singleton and Exports
// ============================================================================

let synthesizer: KokoroSynthesizer | null = null;

function getSynthesizer(): KokoroSynthesizer {
    if (!synthesizer) {
        synthesizer = new KokoroSynthesizer();
    }
    return synthesizer;
}

function speak(text: string): void {
    getSynthesizer().speak(text).catch((error) => {
        ztoolkit.log(`Kokoro TTS error: ${error?.message}`);

        let errorKey = "other";
        if (error?.message && Object.values(ErrorCodes).includes(error.message)) {
            errorKey = error.message;
        }

        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: "kokoro" } }),
             getString("popup-engineErrorCause", { args: { engine: "kokoro", cause: errorKey } })],
            "error"
        );

        addon.data.tts.state = "idle";
    });
}

function stop(): void { synthesizer?.stop(); }
function pause(): void { synthesizer?.pause(); }
function resume(): void { synthesizer?.resume(); }
function skipBackward(): void { synthesizer?.skipBackward(); }
function skipForward(): void { synthesizer?.skipForward(); }
function replaySection(): void { synthesizer?.replaySection(); }
function dispose(): void {
    synthesizer?.dispose();
    synthesizer = null;
}

export {
    setDefaultPrefs,
    initEngine,
    speak,
    stop,
    pause,
    resume,
    skipBackward,
    skipForward,
    replaySection,
    dispose,
    getKokoroConfig,
    fetchModels,
    fetchVoices,
    fetchLangs
};
