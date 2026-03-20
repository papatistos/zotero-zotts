let audioContext: AudioContext | null = null;
let lastCueAt = 0;

const MIN_CUE_GAP_MS = 400;
const CUE_DURATION_S = 0.12;

function playQueuedSpeechCue(): void {
    const nowMs = Date.now();
    if (nowMs - lastCueAt < MIN_CUE_GAP_MS) {
        return;
    }
    lastCueAt = nowMs;

    if (!window.AudioContext) {
        return;
    }

    try {
        audioContext ??= new window.AudioContext();
        const ctx = audioContext;

        const playCue = () => {
            const startTime = ctx.currentTime + 0.01;
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();

            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(880, startTime);
            oscillator.frequency.exponentialRampToValueAtTime(660, startTime + 0.08);

            gainNode.gain.setValueAtTime(0.0001, startTime);
            gainNode.gain.exponentialRampToValueAtTime(0.035, startTime + 0.01);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + CUE_DURATION_S);

            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);

            oscillator.start(startTime);
            oscillator.stop(startTime + CUE_DURATION_S);
        };

        if (ctx.state === "suspended") {
            void ctx.resume().then(playCue).catch(() => {});
        } else {
            playCue();
        }
    } catch (error) {
        ztoolkit.log(`Queued speech cue failed: ${error}`);
    }
}

export {
    playQueuedSpeechCue
}
