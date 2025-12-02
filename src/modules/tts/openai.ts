import { getPref, setPref } from "../utils/prefs";
import { notifyGeneric } from "../utils/notify";
import { getString } from "../utils/locale";

// Get AbortController from window object (not available in global scope in Firefox 115/Zotero 7)
const AbortController = window.AbortController;

// OpenAI Voice options (alphabetically ordered)
type OpenAIVoice = "alloy" | "ash" | "coral" | "echo" | "fable" | "nova" | "onyx" | "sage" | "shimmer";
type OpenAIModel = "tts-1" | "tts-1-hd";

// Error codes for OpenAI TTS
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

// Audio player class for handling MP3 playback from OpenAI
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
            this.audioElement.volume = (getPref("openai.volume") as number) / 100;
            this.audioElement.playbackRate = (getPref("openai.rate") as number) / 100;

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
            this.audioElement.currentTime = Math.min(
                this.audioElement.duration || this.audioElement.currentTime + seconds,
                this.audioElement.currentTime + seconds
            );
            ztoolkit.log(`Skipped forward ${seconds}s to ${this.audioElement.currentTime.toFixed(1)}s`);
        }
    }

    public stop(): void {
        this.resetAudioState();
        this.isPaused = false;
        addon.data.tts.state = "idle";
    }

    public prepareForNewSection(): void {
        // Reset audio state for new section synthesis without changing global state
        this.resetAudioState();
    }

    public dispose(): void {
        this.stop();
        this.audioElement = null;
        this.isInitialized = false;
    }

    private resetAudioState(): void {
        this.isPlaying = false;

        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
            this.currentBlobUrl = null;
        }

        if (this.audioElement && this.audioElement.src) {
            if (!this.audioElement.paused) {
                this.audioElement.pause();
            }
            this.audioElement.removeAttribute("src");
            this.audioElement.load();
        }
    }
}

// Audio queue entry for prefetched audio
interface QueuedAudio {
    blob: Blob;
    section: string;
    index: number;
}

// Session cache entry for current text
interface SessionCache {
    text: string;
    voice: string;
    model: string;
    sections: Blob[]; // All audio blobs for the current text
}

// OpenAI TTS Synthesizer with streaming/prefetch support
class OpenAISynthesizer {
    private audioPlayer: AudioPlayer;
    private textSplitter: TextSectionSplitter;
    private isStopped: boolean = false;
    private abortController: AbortController | null = null;
    private pendingBlobUrl: string | null = null;
    
    // Streaming/prefetch queue
    private audioQueue: QueuedAudio[] = [];
    private prefetchInProgress: Set<number> = new Set(); // Track which sections are being fetched
    private readonly MAX_PREFETCH = 2; // How many sections to prefetch ahead
    
    // Session cache for replaying current text
    private sessionCache: SessionCache | null = null;
    private currentSectionIndex: number = -1; // Currently playing section index
    private nextCachedPlaybackIndex: number = 0; // Next section to play when replaying from cache
    private nextSectionIndex: number = 0; // Next sequential section index to assign when splitting text
    private cachePlaybackActive: boolean = false;

    constructor() {
        this.audioPlayer = new AudioPlayer();
        this.textSplitter = new TextSectionSplitter();
        this.audioPlayer.setOnCompleteCallback(() => this.onAudioComplete());
    }

    public async speak(text: string): Promise<void> {
        // Stop any previous playback
        if (this.audioPlayer) {
            this.audioPlayer.stop();
        }

        // Clear prefetch queue
        this.clearQueue();

        // Reset section tracking
        this.currentSectionIndex = -1;
        this.nextCachedPlaybackIndex = 0;
        this.nextSectionIndex = 0;
        this.cachePlaybackActive = false;

        // Check if we have this text cached
        const voice = getPref("openai.voice") as OpenAIVoice || "alloy";
        const model = getPref("openai.model") as OpenAIModel || "tts-1";
        
        if (this.sessionCache && 
            this.sessionCache.text === text && 
            this.sessionCache.voice === voice &&
            this.sessionCache.model === model) {
            // Play from cache!
            ztoolkit.log(`Playing from session cache: ${this.sessionCache.sections.length} sections`);
            this.currentSectionIndex = -1;
            this.nextCachedPlaybackIndex = 0;
            this.isStopped = false;
            await this.playCachedSection();
            return;
        }

        // Not cached - clear old cache and start fresh
        this.sessionCache = null;
        this.currentSectionIndex = -1;
        this.nextCachedPlaybackIndex = 0;

        // Initialize text section splitting
        this.textSplitter.initialize(text);
        this.isStopped = false;

        // Get first section
        const firstSection = this.textSplitter.getNextSection();
        const firstSectionIndex = this.nextSectionIndex++;
        ztoolkit.log(`OpenAI speak: total ${text.length} chars, first section ${firstSection.length} chars, hasMore: ${this.textSplitter.hasMore()}`);

        // Initialize session cache
        this.sessionCache = {
            text: text,
            voice: voice,
            model: model,
            sections: []
        };

        // Start prefetching next sections while we synthesize the first
        if (this.textSplitter.hasMore()) {
            this.startPrefetching();
        }

        // Synthesize and play first section
        await this.speakSection(firstSection, firstSectionIndex);

        // Check if stopped during synthesis
        if (this.isStopped) {
            return;
        }
    }

    private async speakSection(sectionText: string, sectionIndex: number): Promise<void> {
        // Early return if stopped
        if (this.isStopped) {
            return;
        }

        // Prepare audio player for new section synthesis
        this.audioPlayer.prepareForNewSection();

        await this.audioPlayer.initialize();

        try {
            // Synthesize to blob
            const audioBlob = await this.synthesizeToBlob(sectionText);
            ztoolkit.log(`Received audio: ${audioBlob.size} bytes`);

            // Cache this section
            if (this.sessionCache) {
                this.sessionCache.sections[sectionIndex] = audioBlob;
            }

            // Check if stopped during synthesis
            if (this.isStopped) {
                return;
            }

            // Play the audio
            this.currentSectionIndex = sectionIndex;
            await this.audioPlayer.playAudio(audioBlob);

        } catch (error) {
            // Ignore abort errors (expected when stop() is called)
            if (error instanceof Error && error.name === 'AbortError') {
                ztoolkit.log('OpenAI request aborted');
                return;
            }
            
            throw error;
        }
    }

    public stop(): void {
        this.isStopped = true;
        this.cachePlaybackActive = false;
        
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
            ztoolkit.log(`Playing queued audio: ${queuedAudio.section.length} chars, queue remaining: ${this.audioQueue.length}`);
            
            // Continue prefetching if there are more sections
            if (this.textSplitter.hasMore()) {
                this.startPrefetching();
            }
            
            // Play the queued audio immediately (no API wait!)
            try {
                this.currentSectionIndex = queuedAudio.index;
                await this.audioPlayer.playAudio(queuedAudio.blob);
            } catch (error) {
                ztoolkit.log(`Error playing queued audio: ${error}`);
                addon.data.tts.state = "idle";
            }
            return;
        }

        // No queued audio - check if there are more text sections to synthesize
        if (this.textSplitter.hasMore()) {
            const nextSection = this.textSplitter.getNextSection();
            const nextSectionIndex = this.nextSectionIndex++;
            ztoolkit.log(`No queued audio, fetching next section: ${nextSection.length} chars, hasMore: ${this.textSplitter.hasMore()}`);

            try {
                await this.speakSection(nextSection, nextSectionIndex);
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

    /**
     * Start prefetching upcoming sections in parallel
     */
    private startPrefetching(): void {
        // Don't prefetch more than MAX_PREFETCH sections ahead
        const sectionsToFetch = Math.min(this.MAX_PREFETCH - this.audioQueue.length - this.prefetchInProgress.size, this.MAX_PREFETCH);
        
        for (let i = 0; i < sectionsToFetch && this.textSplitter.hasMore(); i++) {
            const sectionIndex = this.nextSectionIndex++;
            
            if (!this.prefetchInProgress.has(sectionIndex)) {
                this.prefetchInProgress.add(sectionIndex);
                const section = this.textSplitter.getNextSection();
                
                ztoolkit.log(`Prefetching section ${sectionIndex}: ${section.length} chars`);
                
                // Fetch in background without blocking
                this.fetchSection(section, sectionIndex).catch((error) => {
                    ztoolkit.log(`Prefetch error for section ${sectionIndex}: ${error}`);
                    this.prefetchInProgress.delete(sectionIndex);
                });
            }
        }
    }

    /**
     * Fetch a single section and add to queue
     */
    private async fetchSection(sectionText: string, sectionIndex: number): Promise<void> {
        // Early return if stopped
        if (this.isStopped) {
            this.prefetchInProgress.delete(sectionIndex);
            return;
        }

        try {
            const audioBlob = await this.synthesizeToBlob(sectionText);
            
            // Cache this section
            if (this.sessionCache) {
                this.sessionCache.sections[sectionIndex] = audioBlob;
            }
            
            // Check if stopped during fetch
            if (this.isStopped) {
                this.prefetchInProgress.delete(sectionIndex);
                return;
            }
            
            // Add to queue
            this.audioQueue.push({ blob: audioBlob, section: sectionText, index: sectionIndex });
            this.prefetchInProgress.delete(sectionIndex);
            
            ztoolkit.log(`Queued section ${sectionIndex}: ${audioBlob.size} bytes, queue size: ${this.audioQueue.length}`);
        } catch (error) {
            this.prefetchInProgress.delete(sectionIndex);
            throw error;
        }
    }

    /**
     * Synthesize text to audio blob without playing
     */
    private async synthesizeToBlob(sectionText: string): Promise<Blob> {
        // Validate configuration
        const { apiKey } = getOpenAIConfig();
        const voice = getPref("openai.voice") as OpenAIVoice || "alloy";
        const model = getPref("openai.model") as OpenAIModel || "tts-1";

        if (!apiKey) {
            throw new Error(ErrorCodes.CONFIG_INCOMPLETE);
        }

        // Create abort controller for this request
        const controller = new AbortController();

        try {
            const response = await fetch("https://api.openai.com/v1/audio/speech", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: model,
                    input: sectionText,
                    voice: voice,
                    response_format: "mp3",
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                ztoolkit.log(`OpenAI TTS API error: ${response.status} ${response.statusText} - ${errorText}`);

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

            ztoolkit.log(`OpenAI TTS network error: ${error}`);
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
let synthesizer: OpenAISynthesizer | null = null;

function getSynthesizer(): OpenAISynthesizer {
    if (!synthesizer) {
        synthesizer = new OpenAISynthesizer();
    }
    return synthesizer;
}

function setDefaultPrefs(): void {
    if (!getPref("openai.apiKey")) {
        setPref("openai.apiKey", "");
    }

    if (!getPref("openai.voice")) {
        setPref("openai.voice", "alloy");
    }

    if (!getPref("openai.model")) {
        setPref("openai.model", "tts-1");
    }

    if (!getPref("openai.volume")) {
        setPref("openai.volume", 100);
    }

    if (!getPref("openai.rate")) {
        setPref("openai.rate", 100);
    }
}

async function initEngine(): Promise<void> {
    // OpenAI engine initialization always succeeds
    // Actual validation happens when user tries to speak
    // This allows users to configure the engine after installation
    return Promise.resolve();
}

// Get OpenAI configuration from environment variables and preferences
// Preferences override environment variables
function getOpenAIConfig(): { apiKey: string } {
    let apiKey = "";

    // Try environment variables first
    try {
        // @ts-ignore - nsIEnvironment not in type definitions
        const env = Components.classes["@mozilla.org/process/environment;1"]
            .getService(Components.interfaces.nsIEnvironment);
        if (env.exists("OPENAI_API_KEY")) {
            apiKey = env.get("OPENAI_API_KEY");
        }
    } catch (error) {
        ztoolkit.log(`Failed to read OpenAI environment variable: ${error}`);
    }

    // Preferences override environment variables
    const prefKey = (getPref("openai.apiKey") as string || "").trim();
    if (prefKey) {
        apiKey = prefKey;
    }

    return {
        apiKey: apiKey.trim()
    };
}

// Exported functions matching webSpeech.ts pattern
function speak(text: string): void {
    const synth = getSynthesizer();

    synth.speak(text).catch((error) => {
        // Log the full error for debugging
        ztoolkit.log(`OpenAI TTS error (full): ${JSON.stringify(error)}`);
        ztoolkit.log(`OpenAI TTS error.message: ${error?.message}`);
        ztoolkit.log(`OpenAI TTS error.name: ${error?.name}`);
        ztoolkit.log(`OpenAI TTS error stack: ${error?.stack}`);

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
            [getString("popup-engineErrorTitle", { args: { engine: "openai" } }),
             getString("popup-engineErrorCause", { args: { engine: "openai", cause: errorKey } })],
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

// Get available voices (static list for OpenAI, alphabetically ordered)
function getVoices(): OpenAIVoice[] {
    return ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
}

// Get available models (static list for OpenAI)
function getModels(): OpenAIModel[] {
    return ["tts-1", "tts-1-hd"];
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
    getOpenAIConfig,
    getVoices,
    getModels
};
