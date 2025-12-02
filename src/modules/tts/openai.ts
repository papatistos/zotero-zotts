import { getPref, setPref } from "../utils/prefs";
import { notifyGeneric } from "../utils/notify";
import { getString } from "../utils/locale";

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

// OpenAI TTS Synthesizer
class OpenAISynthesizer {
    private audioPlayer: AudioPlayer;
    private textSplitter: TextSectionSplitter;
    private isStopped: boolean = false;

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

        // Initialize text section splitting
        this.textSplitter.initialize(text);
        this.isStopped = false;

        // Get first section
        const firstSection = this.textSplitter.getNextSection();
        ztoolkit.log(`OpenAI speak: total ${text.length} chars, first section ${firstSection.length} chars, hasMore: ${this.textSplitter.hasMore()}`);

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

        // Prepare audio player for new section synthesis
        this.audioPlayer.prepareForNewSection();

        // Validate configuration
        const { apiKey } = getOpenAIConfig();
        const voice = getPref("openai.voice") as OpenAIVoice || "alloy";
        const model = getPref("openai.model") as OpenAIModel || "tts-1";

        if (!apiKey) {
            ztoolkit.log("OpenAI TTS configuration incomplete: missing API key");
            throw new Error(ErrorCodes.CONFIG_INCOMPLETE);
        }

        // Check if stopped before making request
        if (this.isStopped) {
            return;
        }

        await this.audioPlayer.initialize();

        try {
            // Make API request
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

            // Check if stopped during API call
            if (this.isStopped) {
                return;
            }

            // Get audio data as blob
            const audioBlob = await response.blob();
            ztoolkit.log(`Received audio: ${audioBlob.size} bytes`);

            // Play the audio
            await this.audioPlayer.playAudio(audioBlob);

        } catch (error) {
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

    public stop(): void {
        this.isStopped = true;
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

    public dispose(): void {
        this.stop();
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
        ztoolkit.log(`OpenAI TTS error: ${error}`);

        let errorKey = "other";
        if (error.message === ErrorCodes.CONFIG_INCOMPLETE) {
            errorKey = ErrorCodes.CONFIG_INCOMPLETE;
        } else if (error.message === ErrorCodes.AUTH_FAILED) {
            errorKey = ErrorCodes.AUTH_FAILED;
        } else if (error.message === ErrorCodes.CONNECTION_FAILED) {
            errorKey = ErrorCodes.CONNECTION_FAILED;
        } else if (error.message === ErrorCodes.RATE_LIMITED) {
            errorKey = ErrorCodes.RATE_LIMITED;
        } else if (error.message === ErrorCodes.API_ERROR) {
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

    // Resource Management
    dispose,

    // Configuration & Utilities
    getOpenAIConfig,
    getVoices,
    getModels
};
