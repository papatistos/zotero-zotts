import { getPref } from "./prefs";
import { notifyGeneric } from "./notify";
import { getString } from "./locale";

// Plays a stream of raw 16-bit mono PCM chunks back to back with Web Audio.
// Each chunk is scheduled to start exactly where the previous one ends, so
// playback has no gaps. Zotero disables WebM, so MediaSource streaming is not
// an option, but Web Audio needs no codec. Engines apply the speaking rate on
// the server, because changing the playback rate here would change the pitch.
export class PcmStreamPlayer {
    private static readonly START_DELAY = 0.05; // seconds of scheduling headroom

    private readonly engine: string;
    private readonly sampleRate: number;

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

    // engine names the preference prefix for volume and the engine in error messages
    constructor(engine: string, sampleRate: number = 24000) {
        this.engine = engine;
        this.sampleRate = sampleRate;
    }

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
        this.gainNode!.gain.value = (getPref(`${this.engine}.volume`) as number) / 100;
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

    // Seconds of received audio that have not been played yet
    public bufferedSeconds(): number {
        if (!this.context) {
            return 0;
        }
        if (!this.hasStarted) {
            return this.receivedBytes / 2 / this.sampleRate;
        }
        return Math.max(0, this.nextStartTime - this.context.currentTime);
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
        this.nextStartTime = this.context.currentTime + PcmStreamPlayer.START_DELAY;
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
                const buffer = context.createBuffer(1, samples.length, this.sampleRate);
                buffer.copyToChannel(samples, 0);
                const source = context.createBufferSource();
                source.buffer = buffer;
                source.connect(gainNode);

                let startTime = this.nextStartTime;
                if (startTime < context.currentTime) {
                    // Audio arrived later than it was needed; a gap cannot be avoided here
                    ztoolkit.log(`${this.engine} audio underrun of ${(context.currentTime - startTime).toFixed(3)} s`);
                    startTime = context.currentTime + PcmStreamPlayer.START_DELAY;
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
        ztoolkit.log(`${this.engine} audio playback error: ${message}`);
        this.stop();
        notifyGeneric(
            [getString("popup-engineErrorTitle", { args: { engine: this.engine } }),
             getString("popup-engineErrorCause", { args: { engine: this.engine, cause: "playback-failed" } })],
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
