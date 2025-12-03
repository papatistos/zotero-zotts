/**
 * Local TTS Engine - OpenAI-compatible API
 * 
 * This module reuses the OpenAI TTS implementation with a custom API URL.
 * The only differences are:
 * - Uses a configurable local API URL instead of OpenAI's endpoint
 * - No API key required (or optional depending on local setup)
 * - Default voice is "bm_fable"
 */

import { getPref, setPref } from "../utils/prefs";
import { notifyGeneric } from "../utils/notify";
import { getString } from "../utils/locale";

// Error codes for Local TTS
const ErrorCodes = {
    CONFIG_INCOMPLETE: "config-incomplete",
    AUTH_FAILED: "auth-failed",
    CONNECTION_FAILED: "connection-failed",
    RATE_LIMITED: "rate-limited",
    API_ERROR: "api-error"
} as const;

// Get AbortController from window object
const AbortController = window.AbortController;

/**
 * Get configuration for local API
 */
function getLocalConfig(): { apiUrl: string } {
    const apiUrl = (getPref("local.apiUrl") as string || "http://localhost:8880").trim();
    return { apiUrl };
}

/**
 * Set default preferences for local TTS
 */
function setDefaultPrefs(): void {
    if (!getPref("local.apiUrl")) {
        setPref("local.apiUrl", "http://localhost:8880");
    }

    if (!getPref("local.voice")) {
        setPref("local.voice", "bm_fable");
    }

    if (!getPref("local.volume")) {
        setPref("local.volume", 100);
    }

    if (!getPref("local.rate")) {
        setPref("local.rate", 100);
    }
}

/**
 * Initialize the local TTS engine
 */
async function initEngine(): Promise<void> {
    // Local engine initialization always succeeds
    // Actual validation happens when user tries to speak
    return Promise.resolve();
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
            this.audioElement.volume = (getPref("local.volume") as number) / 100;
            this.audioElement.playbackRate = (getPref("local.rate") as number) / 100;

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
    private static readonly FIRST_SECTION_SIZE = 250;
    private static readonly STANDARD_SECTION_SIZE = 1024;
    private static readonly SENTENCE_ADJUSTMENT_LIMIT = 50;

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
    voice: string;
    sections: Blob[];
}

interface QueuedAudio {
    blob: Blob;
    section: string;
    index: number;
}

// ============================================================================
// Local TTS Synthesizer
// ============================================================================

class LocalSynthesizer {
    private audioPlayer: AudioPlayer;
    private textSplitter: TextSectionSplitter;
    private isStopped: boolean = false;
    private abortController: AbortController | null = null;
    
    private audioQueue: QueuedAudio[] = [];
    private prefetchInProgress: Set<number> = new Set();
    private readonly MAX_PREFETCH = 2;
    
    private sessionCache: SessionCache | null = null;
    private currentSectionIndex: number = -1;
    private nextCachedPlaybackIndex: number = 0;
    private nextSectionIndex: number = 0;
    private cachePlaybackActive: boolean = false;

    constructor() {
        this.audioPlayer = new AudioPlayer();
        this.textSplitter = new TextSectionSplitter();
        this.audioPlayer.setOnCompleteCallback(() => this.onAudioComplete());
    }

    public async speak(text: string): Promise<void> {
        this.audioPlayer.stop();
        this.clearQueue();
        
        this.currentSectionIndex = -1;
        this.nextCachedPlaybackIndex = 0;
        this.nextSectionIndex = 0;
        this.cachePlaybackActive = false;

        const voice = getPref("local.voice") as string || "bm_fable";
        
        // Check cache
        if (this.sessionCache?.text === text && this.sessionCache?.voice === voice) {
            ztoolkit.log(`Playing from cache: ${this.sessionCache.sections.length} sections`);
            this.isStopped = false;
            await this.playCachedSection();
            return;
        }

        this.sessionCache = { text, voice, sections: [] };
        this.textSplitter.initialize(text);
        this.isStopped = false;

        const firstSection = this.textSplitter.getNextSection();
        const firstIndex = this.nextSectionIndex++;
        
        ztoolkit.log(`Local speak: ${text.length} chars, first section ${firstSection.length} chars`);

        if (this.textSplitter.hasMore()) {
            this.startPrefetching();
        }

        await this.speakSection(firstSection, firstIndex);
    }

    private async speakSection(sectionText: string, sectionIndex: number): Promise<void> {
        if (this.isStopped) return;

        this.audioPlayer.prepareForNewSection();
        await this.audioPlayer.initialize();

        try {
            const audioBlob = await this.synthesizeToBlob(sectionText);
            ztoolkit.log(`Received audio: ${audioBlob.size} bytes`);

            if (this.sessionCache) {
                this.sessionCache.sections[sectionIndex] = audioBlob;
            }

            if (this.isStopped) return;

            this.currentSectionIndex = sectionIndex;
            await this.audioPlayer.playAudio(audioBlob);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                ztoolkit.log('Local request aborted');
                return;
            }
            throw error;
        }
    }

    private startPrefetching(): void {
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
                
                this.fetchSection(section, sectionIndex).catch((error) => {
                    ztoolkit.log(`Prefetch error: ${error}`);
                    this.prefetchInProgress.delete(sectionIndex);
                });
            }
        }
    }

    private async fetchSection(sectionText: string, sectionIndex: number): Promise<void> {
        if (this.isStopped) {
            this.prefetchInProgress.delete(sectionIndex);
            return;
        }

        try {
            const audioBlob = await this.synthesizeToBlob(sectionText);
            
            if (this.sessionCache) {
                this.sessionCache.sections[sectionIndex] = audioBlob;
            }

            if (this.isStopped) {
                this.prefetchInProgress.delete(sectionIndex);
                return;
            }

            this.audioQueue.push({ blob: audioBlob, section: sectionText, index: sectionIndex });
            ztoolkit.log(`Prefetched section ${sectionIndex}, queue size: ${this.audioQueue.length}`);
            this.prefetchInProgress.delete(sectionIndex);
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
                this.startPrefetching();
            }
            
            this.currentSectionIndex = queued.index;
            this.audioPlayer.playAudio(queued.blob);
            return;
        }

        // Synthesize more
        if (this.textSplitter.hasMore()) {
            const nextSection = this.textSplitter.getNextSection();
            const nextIndex = this.nextSectionIndex++;
            ztoolkit.log(`Fetching next section: ${nextSection.length} chars`);
            
            this.speakSection(nextSection, nextIndex).catch((error) => {
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

    private async synthesizeToBlob(sectionText: string): Promise<Blob> {
        const { apiUrl } = getLocalConfig();
        const voice = getPref("local.voice") as string || "bm_fable";

        if (!apiUrl) {
            throw new Error(ErrorCodes.CONFIG_INCOMPLETE);
        }

        const controller = new AbortController();

        try {
            const response = await fetch(`${apiUrl}/v1/audio/speech`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: "tts-1",
                    input: sectionText,
                    voice: voice,
                    response_format: "mp3",
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                ztoolkit.log(`Local TTS API error: ${response.status} - ${errorText}`);

                if (response.status === 401) throw new Error(ErrorCodes.AUTH_FAILED);
                if (response.status === 429) throw new Error(ErrorCodes.RATE_LIMITED);
                throw new Error(ErrorCodes.API_ERROR);
            }

            return await response.blob();
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            if (error instanceof Error && Object.values(ErrorCodes).includes(error.message as any)) throw error;
            
            ztoolkit.log(`Local TTS network error: ${error}`);
            throw new Error(ErrorCodes.CONNECTION_FAILED);
        }
    }

    private clearQueue(): void {
        this.audioQueue = [];
        this.prefetchInProgress.clear();
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
        this.isStopped = true;
        this.cachePlaybackActive = false;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
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
        this.abortController = null;
    }
}

// ============================================================================
// Singleton and Exports
// ============================================================================

let synthesizer: LocalSynthesizer | null = null;

function getSynthesizer(): LocalSynthesizer {
    if (!synthesizer) {
        synthesizer = new LocalSynthesizer();
    }
    return synthesizer;
}

function speak(text: string): void {
    getSynthesizer().speak(text).catch((error) => {
        ztoolkit.log(`Local TTS error: ${error?.message}`);

        let errorKey = "other";
        if (error?.message && Object.values(ErrorCodes).includes(error.message)) {
            errorKey = error.message;
        }

        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: "local" } }),
             getString("popup-engineErrorCause", { args: { engine: "local", cause: errorKey } })],
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

function getVoices(): string[] {
    return ["bm_fable", "alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
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
    getLocalConfig,
    getVoices
};
