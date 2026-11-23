import { getPref, setPref } from "../utils/prefs";
import { notifyGeneric } from "../utils/notify";
import { getString } from "../utils/locale";
import { PcmStreamPlayer } from "../utils/pcmPlayer";

// Google Cloud Text-to-Speech over its REST API, authenticated with an API key.
// Text is synthesized section by section as 24 kHz LINEAR16, and the PCM of all
// sections is played as one continuous stream, so there are no gaps between them.

const API_BASE = "https://texttospeech.googleapis.com/v1";
const SAMPLE_RATE = 24000;

// Google's rate limits: 0.25x to 4x, but Chirp HD voices only go up to 2x
const MIN_RATE = 0.25;
const MAX_RATE = 4;
const MAX_CHIRP_RATE = 2;

// Section sizes in characters. The first section is short so playback starts
// quickly. Google accepts up to 5000 bytes per request; 1.5x the standard size
// stays below that even for text in a script that needs 3 bytes per character.
const FIRST_SECTION_SIZE = 300;
const STANDARD_SECTION_SIZE = 1000;
const SECTION_OVERFLOW = 1.5;

// Synthesize at most this many seconds of audio ahead of what is playing,
// so a long document is not synthesized (and billed) before it is listened to
const MAX_SECONDS_AHEAD = 30;
const THROTTLE_POLL_MS = 1000;

const ErrorCodes = {
    CONFIG_INCOMPLETE: "config-incomplete",
    AUTH_FAILED: "auth-failed",
    CONNECTION_FAILED: "connection-failed",
    RATE_LIMITED: "rate-limited",
    API_ERROR: "api-error",
    PLAYBACK_UNSUPPORTED: "playback-unsupported",
} as const;

interface GoogleVoice {
    name: string;
    languageCodes: string[];
    ssmlGender?: string;
    naturalSampleRateHertz?: number;
}

// Split text into sections that end at a sentence or line break where possible
function splitSections(text: string): string[] {
    const sections: string[] = [];
    let start = 0;

    while (start < text.length) {
        const target = sections.length === 0 ? FIRST_SECTION_SIZE : STANDARD_SECTION_SIZE;
        const limit = Math.floor(target * SECTION_OVERFLOW);
        const remaining = text.length - start;

        if (remaining <= limit) {
            sections.push(text.substring(start));
            break;
        }

        const window = text.substring(start, start + limit);
        let end = -1;

        // Last sentence or line end before the target, but past half of it
        const boundary = /[.!?]["')\]]*\s+|\n+/g;
        let match: RegExpExecArray | null;
        let firstAfterTarget = -1;
        while ((match = boundary.exec(window)) !== null) {
            const position = match.index + match[0].length;
            if (position <= target) {
                if (position > target / 2) {
                    end = position;
                }
            } else {
                firstAfterTarget = position;
                break;
            }
        }

        // Otherwise the first sentence end after the target, within the overflow
        if (end === -1 && firstAfterTarget !== -1) {
            end = firstAfterTarget;
        }

        // Otherwise the last space before the target
        if (end === -1) {
            const space = window.lastIndexOf(" ", target);
            end = space > target / 2 ? space + 1 : target;
        }

        sections.push(text.substring(start, start + end));
        start += end;
    }

    return sections.filter(section => section.trim().length > 0);
}

// LINEAR16 responses are WAV files; return the PCM samples of the "data" chunk
function extractWavPcm(bytes: Uint8Array): Uint8Array {
    const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (bytes.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
        return bytes;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const id = ascii(offset);
        const size = view.getUint32(offset + 4, true);
        if (id === "data") {
            // Streamed WAVs can declare a size larger than the data present
            return bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + size));
        }
        offset += 8 + size + (size % 2);
    }
    return new Uint8Array(0);
}

function decodeBase64(base64: string): Uint8Array {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function speakingRateFor(voiceName: string, ratePercent: number): number {
    const max = /Chirp/i.test(voiceName) ? MAX_CHIRP_RATE : MAX_RATE;
    const rate = Math.min(max, Math.max(MIN_RATE, ratePercent / 100));
    if (rate !== ratePercent / 100) {
        ztoolkit.log(`Google rate ${ratePercent}% is outside the range of ${voiceName}, using ${Math.round(rate * 100)}%`);
    }
    return rate;
}

class GoogleSynthesizer {
    private audioPlayer: PcmStreamPlayer;
    // Incremented on every speak and stop so work for an old request is dropped
    private session: number = 0;
    private activeControllers: Set<AbortController> = new Set();

    constructor() {
        this.audioPlayer = new PcmStreamPlayer("google", SAMPLE_RATE);
    }

    public async speak(text: string): Promise<void> {
        this.stop();
        const session = this.session;

        const { apiKey } = getGoogleConfig();
        const languageCode = (getPref("google.language") as string || "").trim();
        const voiceName = (getPref("google.voice") as string || "").trim();
        if (!apiKey || !languageCode || !voiceName) {
            ztoolkit.log(`Google TTS configuration incomplete: key=${apiKey ? "set" : "missing"}, language="${languageCode}", voice="${voiceName}"`);
            throw new Error(ErrorCodes.CONFIG_INCOMPLETE);
        }

        const sections = splitSections(text);
        ztoolkit.log(`Google speak: ${text.length} chars in ${sections.length} sections`);

        try {
            await this.audioPlayer.startStream();
        } catch (error) {
            throw new Error(ErrorCodes.PLAYBACK_UNSUPPORTED);
        }
        if (session !== this.session) return;

        // Each section starts playing as soon as it arrives
        this.audioPlayer.preloadBytes = 0;
        addon.data.tts.state = "playing";

        for (const section of sections) {
            const pcm = await this.synthesize(section, apiKey, languageCode, voiceName, session);
            if (session !== this.session) return;
            await this.audioPlayer.queueAudioChunk(pcm);

            while (session === this.session && this.audioPlayer.bufferedSeconds() > MAX_SECONDS_AHEAD) {
                await new Promise(resolve => setTimeout(resolve, THROTTLE_POLL_MS));
            }
            if (session !== this.session) return;
        }

        await this.audioPlayer.onSynthesisComplete();
    }

    public stop(): void {
        this.session++;
        for (const controller of this.activeControllers) {
            controller.abort();
        }
        this.activeControllers.clear();
        this.audioPlayer.stop();
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

    private async synthesize(text: string, apiKey: string, languageCode: string, voiceName: string, session: number): Promise<Uint8Array> {
        const controller = new window.AbortController();
        this.activeControllers.add(controller);

        try {
            const response = await fetch(`${API_BASE}/text:synthesize`, {
                method: "POST",
                headers: {
                    "X-Goog-Api-Key": apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    input: { text },
                    voice: { languageCode, name: voiceName },
                    audioConfig: {
                        audioEncoding: "LINEAR16",
                        sampleRateHertz: SAMPLE_RATE,
                        speakingRate: speakingRateFor(voiceName, getPref("google.rate") as number || 100),
                    },
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                ztoolkit.log(`Google TTS API error: ${response.status} ${response.statusText} - ${errorText}`);
                if (response.status === 401 || response.status === 403) {
                    throw new Error(ErrorCodes.AUTH_FAILED);
                } else if (response.status === 429) {
                    throw new Error(ErrorCodes.RATE_LIMITED);
                }
                throw new Error(ErrorCodes.API_ERROR);
            }

            const json = await response.json() as { audioContent?: string };
            if (!json.audioContent) {
                ztoolkit.log("Google TTS response had no audioContent");
                throw new Error(ErrorCodes.API_ERROR);
            }
            return extractWavPcm(decodeBase64(json.audioContent));
        } catch (error) {
            if (session !== this.session || (error instanceof Error && error.name === "AbortError")) {
                const aborted = new Error("Request cancelled");
                aborted.name = "AbortError";
                throw aborted;
            }
            if (error instanceof Error && (Object.values(ErrorCodes) as string[]).includes(error.message)) {
                throw error;
            }
            ztoolkit.log(`Google TTS network error: ${error}`);
            throw new Error(ErrorCodes.CONNECTION_FAILED);
        } finally {
            this.activeControllers.delete(controller);
        }
    }
}

// Singleton instance management
let synthesizer: GoogleSynthesizer | null = null;

function getSynthesizer(): GoogleSynthesizer {
    if (!synthesizer) {
        synthesizer = new GoogleSynthesizer();
    }
    return synthesizer;
}

function setDefaultPrefs(): void {
    if (!getPref("google.apiKey")) {
        setPref("google.apiKey", "");
    }
    if (!getPref("google.language")) {
        setPref("google.language", "en-US");
    }
    if (!getPref("google.volume")) {
        setPref("google.volume", 100);
    }
    if (!getPref("google.rate")) {
        setPref("google.rate", 100);
    }
    // No default voice - user must select after fetching from API
}

async function initEngine(): Promise<void> {
    // Initialization always succeeds; the key is checked when speaking,
    // so users can configure the engine after installation
    return Promise.resolve();
}

// The preference overrides the GOOGLE_TTS_API_KEY environment variable
function getGoogleConfig(): { apiKey: string } {
    let apiKey = "";

    try {
        // @ts-ignore - nsIEnvironment not in type definitions
        const env = Components.classes["@mozilla.org/process/environment;1"]
            .getService(Components.interfaces.nsIEnvironment);
        if (env.exists("GOOGLE_TTS_API_KEY")) {
            apiKey = env.get("GOOGLE_TTS_API_KEY");
        }
    } catch (error) {
        ztoolkit.log(`Failed to read Google environment variable: ${error}`);
    }

    const prefKey = (getPref("google.apiKey") as string || "").trim();
    if (prefKey) {
        apiKey = prefKey;
    }

    return { apiKey: apiKey.trim() };
}

function speak(text: string): void {
    getSynthesizer().speak(text).catch((error) => {
        if (error?.name === "AbortError") {
            return; // Stopped or replaced by a newer request
        }
        ztoolkit.log(`Google TTS error: ${error}`);

        const known = (Object.values(ErrorCodes) as string[]).includes(error?.message);
        const errorKey = known ? error.message : "other";

        // Stop so an error in a later section does not leave earlier audio queued
        synthesizer?.stop();
        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: "google" } }),
             getString("popup-engineErrorCause", { args: { engine: "google", cause: errorKey } })],
            "error"
        );
        addon.data.tts.state = "idle";
    });
}

function stop(): void {
    if (synthesizer) {
        synthesizer.stop();
    }
    addon.data.tts.state = "idle";
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

// Extras for preferences UI
async function getAllVoices(): Promise<{ success: boolean; voices: GoogleVoice[] }> {
    const { apiKey } = getGoogleConfig();
    if (!apiKey) {
        ztoolkit.log("No Google API key available");
        return { success: false, voices: [] };
    }

    try {
        const response = await fetch(`${API_BASE}/voices`, {
            method: "GET",
            headers: { "X-Goog-Api-Key": apiKey },
        });
        if (!response.ok) {
            ztoolkit.log(`Failed to fetch Google voices: ${response.status} ${response.statusText}`);
            return { success: false, voices: [] };
        }

        const json = await response.json() as { voices?: GoogleVoice[] };
        if (!Array.isArray(json.voices)) {
            ztoolkit.log("Invalid response format from Google voices API");
            return { success: false, voices: [] };
        }
        return { success: true, voices: json.voices };
    } catch (error) {
        ztoolkit.log(`Error fetching voices from Google: ${error}`);
        return { success: false, voices: [] };
    }
}

function extractLanguages(voices: GoogleVoice[]): string[] {
    const languages = new Set<string>();
    for (const voice of voices) {
        for (const code of voice.languageCodes ?? []) {
            languages.add(code);
        }
    }
    return Array.from(languages).sort();
}

function filterVoicesByLanguage(voices: GoogleVoice[], language: string): string[] {
    return voices
        .filter(voice => (voice.languageCodes ?? []).includes(language))
        .map(voice => voice.name)
        .filter(name => name)
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

    // Resource Management
    dispose,

    // Configuration & Utilities
    getGoogleConfig,
    getAllVoices,
    extractLanguages,
    filterVoicesByLanguage,
};
