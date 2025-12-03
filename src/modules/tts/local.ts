import { getPref, setPref } from "../utils/prefs";
import { notifyGeneric } from "../utils/notify";
import { getString } from "../utils/locale";

// Get AbortController from window object (not available in global scope in Firefox 115/Zotero 7)
const AbortController = window.AbortController;

// Voice options for local API (can be customized)
type LocalVoice = string;
type LocalModel = "tts-1" | "tts-1-hd";

// Error codes for Local TTS
const ErrorCodes = {
    CONFIG_INCOMPLETE: "config-incomplete",
    AUTH_FAILED: "auth-failed",
    CONNECTION_FAILED: "connection-failed",
    RATE_LIMITED: "rate-limited",
    API_ERROR: "api-error"
} as const;

// Text section splitter for handling long text synthesis
class TextSectionSplitter {
    private static readonly MAX_SECTION_SIZE = 4096; // OpenAI TTS has limit of 4096 characters per request
    private static readonly FIRST_SECTION_SIZE = 250; // Smaller first chunk for faster initial playback
    private static readonly STANDARD_SECTION_SIZE = 1024; // Standard chunk size for streaming
    private static readonly SENTENCE_ADJUSTMENT_LIMIT = 50; // Allow up to +50 chars to end on sentence boundary

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
        if (!this.hasMore()) {
            return "";
        }

        const sectionEnd = this.findSectionEnd(this.currentIndex);
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

    private findSectionEnd(startIndex: number): number {
        const remaining = this.fullText.length - startIndex;
        
        // Determine target size based on whether this is the first section
        const targetSize = this.isFirstSection 
            ? TextSectionSplitter.FIRST_SECTION_SIZE 
            : TextSectionSplitter.STANDARD_SECTION_SIZE;
        
        if (remaining <= targetSize) {
            return this.fullText.length;
        }

        // Allow small overflow to stay in same section when we're close to the end
        if (remaining <= targetSize + TextSectionSplitter.SENTENCE_ADJUSTMENT_LIMIT) {
            return this.fullText.length;
        }

        // Respect maximum section size and compute search windows
        const maxEnd = Math.min(this.fullText.length, startIndex + TextSectionSplitter.MAX_SECTION_SIZE);
        const baseSearchEnd = Math.min(startIndex + targetSize, maxEnd);
        const searchText = this.fullText.substring(startIndex, baseSearchEnd);
        const minSearchPos = Math.floor(targetSize * 0.5);

        // First, try to align with a sentence boundary within ±SENTENCE_ADJUSTMENT_LIMIT of the target size
        const sentenceSearchStart = Math.max(startIndex, baseSearchEnd - TextSectionSplitter.SENTENCE_ADJUSTMENT_LIMIT);
        const sentenceSearchEnd = Math.min(maxEnd, baseSearchEnd + TextSectionSplitter.SENTENCE_ADJUSTMENT_LIMIT);

        if (sentenceSearchEnd > sentenceSearchStart) {
            const sentenceWindow = this.fullText.substring(sentenceSearchStart, sentenceSearchEnd);
            const sentencePattern = /[.!?]["')\]]*\s/g;
            let sentenceMatch: RegExpExecArray | null;
            let candidateBefore: number | null = null;
            let candidateAfter: number | null = null;

            while ((sentenceMatch = sentencePattern.exec(sentenceWindow)) !== null) {
                const absoluteEnd = sentenceSearchStart + sentenceMatch.index + sentenceMatch[0].length;

                if (absoluteEnd <= baseSearchEnd) {
                    if (!candidateBefore || absoluteEnd > candidateBefore) {
                        candidateBefore = absoluteEnd;
                    }
                } else {
                    candidateAfter = absoluteEnd;
                    break; // first boundary after target is ideal
                }
            }

            const logSentenceSplit = (label: string, position: number) => {
                const previewBefore = this.fullText.substring(Math.max(0, position - 30), position);
                const previewAfter = this.fullText.substring(position, Math.min(this.fullText.length, position + 30));
                ztoolkit.log(`${label}: ...${previewBefore} | ${previewAfter}...`);
            };

            if (candidateAfter) {
                logSentenceSplit("Sentence boundary after target", candidateAfter);
                return candidateAfter;
            }

            if (candidateBefore) {
                logSentenceSplit("Sentence boundary before target", candidateBefore);
                return candidateBefore;
            }
        }

        // Priority: paragraph boundary > line+indent > punctuation > single line > tab
        const breakPatterns = [
            /\n\n/g,    // Paragraph separator
            /\n\t/g,    // Line break + tab (likely paragraph start)
            /\n /g,     // Line break + space (possible paragraph start)
            /[.!?]\s/g, // Sentence ending with whitespace
            /:\s/g,     // Colon + whitespace (break after colon)
            /;\s/g,     // Semicolon + whitespace (break after semicolon)
            /,\s/g,     // Comma + whitespace (break after comma)
            /\n/g,      // Single line break
            /\s/g,      // Any whitespace
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

        // If no boundary found yet, search forward (up to adjustment limit) for sentence endings
        const forwardSearchEnd = Math.min(baseSearchEnd + TextSectionSplitter.SENTENCE_ADJUSTMENT_LIMIT, maxEnd);
        if (forwardSearchEnd > baseSearchEnd) {
            const forwardText = this.fullText.substring(baseSearchEnd, forwardSearchEnd);
            const sentencePatterns = [/[.!?]\s/g, /:\s/g, /;\s/g];

            for (const pattern of sentencePatterns) {
                pattern.lastIndex = 0;
                const match = pattern.exec(forwardText);
                if (match) {
                    const sectionEnd = baseSearchEnd + match.index + match[0].length;
                    const previewBefore = this.fullText.substring(Math.max(0, sectionEnd - 30), sectionEnd);
                    const previewAfter = this.fullText.substring(sectionEnd, Math.min(this.fullText.length, sectionEnd + 30));
                    ztoolkit.log(`Forward split to sentence boundary "${match[0]}": ...${previewBefore} | ${previewAfter}...`);
                    return sectionEnd;
                }
            }
        }

        // No suitable break point found, force split at target boundary
        const previewBefore = this.fullText.substring(Math.max(0, baseSearchEnd - 30), baseSearchEnd);
        const previewAfter = this.fullText.substring(baseSearchEnd, Math.min(this.fullText.length, baseSearchEnd + 30));
        ztoolkit.log(`No suitable break point found, forcing split at ${targetSize}: ...${previewBefore} | ${previewAfter}...`);

        return baseSearchEnd;
    }
}

// Audio player class for handling MP3 playback from Local API
class AudioPlayer {
    private audioElement: HTMLAudioElement | null = null;
    private isPlaying: boolean = false;
    private isPaused: boolean = false;
    private isInitialized: boolean = false;
    private onAllSegmentsComplete?: () => void;
    private currentBlobUrl: string | null = null;

    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        this.audioElement = new window.Audio();
        this.audioElement.autoplay = false;
        this.isInitialized = true;
    }

    public setOnCompleteCallback(callback: () => void): void {
        this.onAllSegmentsComplete = callback;
    }

    public async playAudio(audioBlob: Blob): Promise<void> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // Clean up previous blob URL if exists
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

            // When audio finishes, trigger callback
            this.audioElement.onended = () => {
                URL.revokeObjectURL(url);
                this.currentBlobUrl = null;
                this.isPlaying = false;

                if (this.onAllSegmentsComplete) {
                    this.onAllSegmentsComplete();
                } else {
                    addon.data.tts.state = "idle";
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
        if (this.audioElement && this.isInitialized) {
            return this.audioElement.currentTime;
        }
        return 0;
    }

    public skipBackward(seconds: number = 10): void {
        if (this.audioElement && this.isInitialized) {
            const newTime = this.audioElement.currentTime - seconds;
            if (newTime < 0) {
                // Can't skip before the start of current segment
                // Set to beginning instead
                this.audioElement.currentTime = 0;
                ztoolkit.log(`Skipped backward to start of segment (requested ${seconds}s, only ${this.audioElement.currentTime.toFixed(1)}s available)`);
            } else {
                this.audioElement.currentTime = newTime;
                ztoolkit.log(`Skipped backward ${seconds}s to ${this.audioElement.currentTime.toFixed(1)}s`);
            }
        }
    }

    public skipForward(seconds: number = 10): void {
        if (this.audioElement && this.isInitialized) {
            const duration = this.audioElement.duration;
            const currentTime = this.audioElement.currentTime;
            const newTime = currentTime + seconds;

            if (newTime >= duration) {
                ztoolkit.log(`Cannot skip forward ${seconds}s (would exceed duration ${duration.toFixed(1)}s)`);
                // Don't skip beyond the end; let the segment finish naturally
            } else {
                this.audioElement.currentTime = newTime;
                ztoolkit.log(`Skipped forward ${seconds}s to ${this.audioElement.currentTime.toFixed(1)}s`);
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

// Session cache for storing audio segments for replay functionality
interface SessionCache {
    sections: Blob[];
}

// Local API Synthesizer
class LocalSynthesizer {
    private textSplitter: TextSectionSplitter = new TextSectionSplitter();
    private audioPlayer: AudioPlayer = new AudioPlayer();
    private audioQueue: Blob[] = [];
    private prefetchInProgress: Set<number> = new Set();
    private abortController: typeof AbortController.prototype | null = null;
    private isStopped: boolean = false;
    private sessionCache: SessionCache | null = null;
    private currentSectionIndex: number = -1;
    private nextCachedPlaybackIndex: number = 0;
    private cachePlaybackActive: boolean = false;

    public async speak(text: string): Promise<void> {
        this.textSplitter.initialize(text);
        await this.audioPlayer.initialize();
        this.audioPlayer.setOnCompleteCallback(this.onAudioComplete.bind(this));
        this.isStopped = false;

        // Initialize session cache
        this.sessionCache = {
            sections: []
        };
        this.currentSectionIndex = -1;
        this.nextCachedPlaybackIndex = 0;
        this.cachePlaybackActive = false;

        // Synthesize and play first section
        await this.synthesizeAndPlay();
    }

    private async synthesizeAndPlay(): Promise<void> {
        if (this.isStopped) {
            return;
        }

        if (!this.textSplitter.hasMore()) {
            return;
        }

        const sectionText = this.textSplitter.getNextSection();
        if (!sectionText) {
            return;
        }

        try {
            const audioBlob = await this.synthesizeToBlob(sectionText);
            
            // Cache the audio
            if (this.sessionCache) {
                this.sessionCache.sections.push(audioBlob);
                this.currentSectionIndex = this.sessionCache.sections.length - 1;
            }

            await this.audioPlayer.playAudio(audioBlob);

            // Prefetch next section if available
            if (this.textSplitter.hasMore()) {
                this.prefetchNext();
            }
        } catch (error) {
            throw error;
        }
    }

    private prefetchNext(): void {
        const nextIndex = this.sessionCache ? this.sessionCache.sections.length : 0;

        if (this.prefetchInProgress.has(nextIndex)) {
            return;
        }

        if (!this.textSplitter.hasMore()) {
            return;
        }

        this.prefetchInProgress.add(nextIndex);

        const sectionText = this.textSplitter.getNextSection();
        if (!sectionText) {
            this.prefetchInProgress.delete(nextIndex);
            return;
        }

        this.synthesizeToBlob(sectionText)
            .then((audioBlob) => {
                if (!this.isStopped) {
                    this.audioQueue.push(audioBlob);

                    // Cache the audio
                    if (this.sessionCache) {
                        this.sessionCache.sections.push(audioBlob);
                    }

                    // Prefetch next section if available
                    if (this.textSplitter.hasMore()) {
                        this.prefetchNext();
                    }
                }
                this.prefetchInProgress.delete(nextIndex);
            })
            .catch((error) => {
                ztoolkit.log(`Prefetch error: ${error}`);
                this.prefetchInProgress.delete(nextIndex);
            });
    }

    public stop(): void {
        this.isStopped = true;
        
        // Abort any pending fetch requests
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        
        // Clear prefetch queue
        this.clearQueue();
        
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

    public skipBackward(): void {
        // First try to skip within current segment
        const currentTime = this.audioPlayer.getCurrentTime();
        const targetTime = currentTime - 10;
        
        ztoolkit.log(`skipBackward: currentTime=${currentTime.toFixed(1)}s, targetTime=${targetTime.toFixed(1)}s, currentSectionIndex=${this.currentSectionIndex}, hasCache=${!!this.sessionCache}`);
        
        if (targetTime >= 0) {
            // Can skip within current segment
            this.audioPlayer.skipBackward(10);
            return;
        }

        if (this.sessionCache && this.currentSectionIndex > 0) {
            const previousIndex = this.currentSectionIndex - 1;
            const previousBlob = this.sessionCache.sections[previousIndex];

            if (previousBlob) {
                ztoolkit.log(`Skipping back to cached section ${previousIndex}`);
                this.audioPlayer.stop();
                this.isStopped = false;
                this.playCachedSection(previousIndex).catch((error) => {
                    ztoolkit.log(`Error playing previous section: ${error}`);
                });
                return;
            }
        }

        // At the beginning or cache unavailable; reset to start of current segment
        ztoolkit.log(`At beginning or no cache, resetting to start of current segment`);
        this.audioPlayer.skipBackward(10);
    }

    public skipForward(): void {
        this.audioPlayer.skipForward(10);
    }

    public async replaySection(): Promise<void> {
        // If we have a session cache and are currently playing, replay from the beginning
        if (this.sessionCache && this.sessionCache.sections.length > 0) {
            ztoolkit.log(`Replaying from session cache: ${this.sessionCache.sections.length} sections`);
            this.audioPlayer.stop();
            this.currentSectionIndex = -1;
            this.nextCachedPlaybackIndex = 0;
            this.isStopped = false;
            await this.playCachedSection();
        } else {
            ztoolkit.log('No cached sections to replay');
        }
    }

    public dispose(): void {
        this.stop();
        this.audioPlayer.dispose();
        this.abortController = null;
    }

    private async onAudioComplete(): Promise<void> {
        // Early return if stopped
        if (this.isStopped) {
            this.textSplitter.reset();
            addon.data.tts.state = "idle";
            return;
        }

        // If playing from cache, continue with next cached section
        if (this.cachePlaybackActive && this.sessionCache && this.nextCachedPlaybackIndex < this.sessionCache.sections.length) {
            ztoolkit.log(`Continuing cached playback: next section ${this.nextCachedPlaybackIndex}/${this.sessionCache.sections.length}`);
            await this.playCachedSection();
            return;
        } else if (this.cachePlaybackActive) {
            // Exhausted cached playback, fall back to streaming state
            this.cachePlaybackActive = false;
        }

        // Check if we have prefetched audio ready in queue
        if (this.audioQueue.length > 0) {
            const queuedAudio = this.audioQueue.shift()!;
            this.currentSectionIndex++;
            await this.audioPlayer.playAudio(queuedAudio);
            return;
        }

        // Check if there's more text to process
        if (this.textSplitter.hasMore()) {
            await this.synthesizeAndPlay();
        } else {
            addon.data.tts.state = "idle";
        }
    }

    /**
     * Synthesize text to audio blob without playing
     */
    private async synthesizeToBlob(sectionText: string): Promise<Blob> {
        // Validate configuration
        const { apiUrl } = getLocalConfig();
        const voice = getPref("local.voice") as LocalVoice || "bm_fable";

        if (!apiUrl) {
            throw new Error(ErrorCodes.CONFIG_INCOMPLETE);
        }

        // Create abort controller for this request
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
                ztoolkit.log(`Local TTS API error: ${response.status} ${response.statusText} - ${errorText}`);

                if (response.status === 401) {
                    throw new Error(ErrorCodes.AUTH_FAILED);
                } else if (response.status === 429) {
                    throw new Error(ErrorCodes.RATE_LIMITED);
                } else {
                    throw new Error(ErrorCodes.API_ERROR);
                }
            }

            return await response.blob();
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw error;
            }
            
            if (error instanceof Error && 
                (error.message === ErrorCodes.AUTH_FAILED || 
                 error.message === ErrorCodes.RATE_LIMITED || 
                 error.message === ErrorCodes.API_ERROR ||
                 error.message === ErrorCodes.CONFIG_INCOMPLETE)) {
                throw error;
            }

            ztoolkit.log(`Local TTS network error: ${error}`);
            throw new Error(ErrorCodes.CONNECTION_FAILED);
        }
    }

    /**
     * Clear prefetch queue and revoke blob URLs
     */
    private clearQueue(): void {
        this.audioQueue = [];
        this.prefetchInProgress.clear();
    }

    /**
     * Play audio from session cache
     */
    private async playCachedSection(startIndex?: number): Promise<void> {
        if (!this.sessionCache) {
            this.cachePlaybackActive = false;
            addon.data.tts.state = "idle";
            return;
        }

        if (this.sessionCache.sections.length === 0) {
            this.cachePlaybackActive = false;
            addon.data.tts.state = "idle";
            return;
        }

        if (typeof startIndex === "number") {
            this.nextCachedPlaybackIndex = Math.max(0, Math.min(startIndex, this.sessionCache.sections.length - 1));
        }

        if (this.nextCachedPlaybackIndex < 0 || this.nextCachedPlaybackIndex >= this.sessionCache.sections.length) {
            this.cachePlaybackActive = false;
            addon.data.tts.state = "idle";
            return;
        }

        const audioBlob = this.sessionCache.sections[this.nextCachedPlaybackIndex];

        if (!audioBlob) {
            ztoolkit.log(`No cached audio available for section ${this.nextCachedPlaybackIndex}`);
            this.cachePlaybackActive = false;
            addon.data.tts.state = "idle";
            return;
        }

        const indexToPlay = this.nextCachedPlaybackIndex;
        this.currentSectionIndex = indexToPlay;
        this.nextCachedPlaybackIndex = indexToPlay + 1;
        this.cachePlaybackActive = true;

        try {
            await this.audioPlayer.playAudio(audioBlob);
        } catch (error) {
            ztoolkit.log(`Error playing cached section: ${error}`);
            this.cachePlaybackActive = false;
            addon.data.tts.state = "idle";
        }
    }
}

// Singleton instance management
let synthesizer: LocalSynthesizer | null = null;

function getSynthesizer(): LocalSynthesizer {
    if (!synthesizer) {
        synthesizer = new LocalSynthesizer();
    }
    return synthesizer;
}

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

async function initEngine(): Promise<void> {
    // Local engine initialization always succeeds
    // Actual validation happens when user tries to speak
    // This allows users to configure the engine after installation
    return Promise.resolve();
}

// Get Local configuration from preferences
function getLocalConfig(): { apiUrl: string } {
    const apiUrl = (getPref("local.apiUrl") as string || "http://localhost:8880").trim();

    return {
        apiUrl: apiUrl
    };
}

// Exported functions matching webSpeech.ts pattern
function speak(text: string): void {
    const synth = getSynthesizer();

    synth.speak(text).catch((error) => {
        // Log the full error for debugging
        ztoolkit.log(`Local TTS error (full): ${JSON.stringify(error)}`);
        ztoolkit.log(`Local TTS error.message: ${error?.message}`);
        ztoolkit.log(`Local TTS error.name: ${error?.name}`);
        ztoolkit.log(`Local TTS error stack: ${error?.stack}`);

        let errorKey = "other";
        if (error?.message === ErrorCodes.CONFIG_INCOMPLETE) {
            errorKey = ErrorCodes.CONFIG_INCOMPLETE;
        } else if (error?.message === ErrorCodes.AUTH_FAILED) {
            errorKey = ErrorCodes.AUTH_FAILED;
        } else if (error?.message === ErrorCodes.CONNECTION_FAILED) {
            errorKey = ErrorCodes.CONNECTION_FAILED;
        } else if (error?.message === ErrorCodes.RATE_LIMITED) {
            errorKey = ErrorCodes.RATE_LIMITED;
        } else if (error?.message === ErrorCodes.API_ERROR) {
            errorKey = ErrorCodes.API_ERROR;
        }

        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: "local" } }),
             getString("popup-engineErrorCause", { args: { engine: "local", cause: errorKey } })],
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

function skipBackward(): void {
    if (synthesizer) {
        synthesizer.skipBackward();
    }
}

function skipForward(): void {
    if (synthesizer) {
        synthesizer.skipForward();
    }
}

function replaySection(): void {
    if (synthesizer) {
        synthesizer.replaySection();
    }
}

function dispose(): void {
    if (synthesizer) {
        synthesizer.dispose();
        synthesizer = null;
    }
}

// Get available voices (customizable based on local API)
function getVoices(): string[] {
    // Return a default list, can be extended based on the local API
    return ["bm_fable", "alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
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
    skipBackward,
    skipForward,
    replaySection,

    // Resource Management
    dispose,

    // Configuration & Utilities
    getLocalConfig,
    getVoices
};
