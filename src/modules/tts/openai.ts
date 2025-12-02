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

// Simple state for audio playback
let audioElement: HTMLAudioElement | null = null;
let currentBlobUrl: string | null = null;

function setDefaultPrefs(): void {
    if (getPref("openai.apiKey") === undefined) {
        setPref("openai.apiKey", "");
    }
    if (getPref("openai.voice") === undefined) {
        setPref("openai.voice", "alloy");
    }
    if (getPref("openai.model") === undefined) {
        setPref("openai.model", "tts-1");
    }
    if (getPref("openai.volume") === undefined) {
        setPref("openai.volume", 100);
    }
    if (getPref("openai.rate") === undefined) {
        setPref("openai.rate", 100);
    }
}

async function initEngine(): Promise<void> {
    // OpenAI engine initialization always succeeds
    // Actual validation happens when user tries to speak
    return Promise.resolve();
}

// Get OpenAI configuration from environment variables and preferences
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
        // Environment variable reading failed, continue with preferences
    }

    // Preferences override environment variables
    const prefKey = (getPref("openai.apiKey") as string || "").trim();
    if (prefKey) {
        apiKey = prefKey;
    }

    return { apiKey: apiKey.trim() };
}

function speak(text: string): void {
    // Stop any previous playback
    stop();

    const { apiKey } = getOpenAIConfig();
    const voice = getPref("openai.voice") as OpenAIVoice || "alloy";
    const model = getPref("openai.model") as OpenAIModel || "tts-1";

    if (!apiKey) {
        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: "openai" } }),
             getString("popup-engineErrorCause", { args: { engine: "openai", cause: ErrorCodes.CONFIG_INCOMPLETE } })],
            "error"
        );
        return;
    }

    addon.data.tts.state = "playing";

    fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: model,
            input: text.substring(0, 4096), // OpenAI limit
            voice: voice,
            response_format: "mp3",
        }),
    })
    .then(async (response) => {
        if (!response.ok) {
            let errorKey: string = ErrorCodes.API_ERROR;
            if (response.status === 401) {
                errorKey = ErrorCodes.AUTH_FAILED;
            } else if (response.status === 429) {
                errorKey = ErrorCodes.RATE_LIMITED;
            }
            throw new Error(errorKey);
        }
        return response.blob();
    })
    .then((audioBlob) => {
        // Clean up previous blob URL
        if (currentBlobUrl) {
            URL.revokeObjectURL(currentBlobUrl);
        }

        currentBlobUrl = URL.createObjectURL(audioBlob);
        
        if (!audioElement) {
            audioElement = new window.Audio();
        }
        
        audioElement.src = currentBlobUrl;
        audioElement.volume = (getPref("openai.volume") as number) / 100;
        audioElement.playbackRate = (getPref("openai.rate") as number) / 100;
        
        audioElement.onended = () => {
            if (currentBlobUrl) {
                URL.revokeObjectURL(currentBlobUrl);
                currentBlobUrl = null;
            }
            addon.data.tts.state = "idle";
        };
        
        audioElement.play().catch((error) => {
            ztoolkit.log(`Audio playback error: ${error}`);
            addon.data.tts.state = "idle";
        });
    })
    .catch((error) => {
        ztoolkit.log(`OpenAI TTS error: ${error}`);
        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: "openai" } }),
             getString("popup-engineErrorCause", { args: { engine: "openai", cause: error.message || "other" } })],
            "error"
        );
        addon.data.tts.state = "idle";
    });
}

function stop(): void {
    if (audioElement) {
        audioElement.pause();
        audioElement.removeAttribute("src");
    }
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }
    addon.data.tts.state = "idle";
}

function pause(): void {
    if (audioElement && !audioElement.paused) {
        audioElement.pause();
        addon.data.tts.state = "paused";
    }
}

function resume(): void {
    if (audioElement && audioElement.paused && audioElement.src) {
        audioElement.play();
        addon.data.tts.state = "playing";
    }
}

function dispose(): void {
    stop();
    audioElement = null;
}

// Get available voices (static list for OpenAI)
function getVoices(): OpenAIVoice[] {
    return ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
}

// Get available models (static list for OpenAI)
function getModels(): OpenAIModel[] {
    return ["tts-1", "tts-1-hd"];
}

export {
    setDefaultPrefs,
    initEngine,
    speak,
    stop,
    pause,
    resume,
    dispose,
    getOpenAIConfig,
    getVoices,
    getModels
};
