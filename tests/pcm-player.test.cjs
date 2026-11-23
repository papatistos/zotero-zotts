const test = require('node:test');
const assert = require('node:assert/strict');
const {load, prefs} = require('./helpers.cjs');

function harness({audioContext = true} = {}) {
    const contexts = [], notices = [];
    const addon = {data: {tts: {state: 'playing'}}};
    class AudioContext {
        constructor() {this.currentTime = 0; this.state = 'running'; this.sources = []; this.destination = {}; contexts.push(this);}
        createGain() {return this.gain = {gain: {value: 1}, connect() {}};}
        createBuffer(channels, length, sampleRate) {
            assert.equal(channels, 1); assert.equal(sampleRate, 24000);
            return {length, duration: length / sampleRate, copyToChannel(samples) {this.samples = Array.from(samples);}};
        }
        createBufferSource() {
            const context = this;
            const source = {stopped: false, connect() {}, start(when) {this.when = when; context.sources.push(this);}, stop() {this.stopped = true;}};
            return source;
        }
        suspend() {this.state = 'suspended'; return Promise.resolve();}
        resume() {this.state = 'running'; return Promise.resolve();}
        close() {this.state = 'closed'; return Promise.resolve();}
    }
    const utils = {
        prefs: prefs({'azure.volume': 80}),
        notify: {notifyGeneric(lines) {notices.push(lines);}},
        locale: {getString: (id, opts) => opts?.args?.cause ?? id},
    };
    const globals = {window: audioContext ? {AudioContext} : {}, addon, ztoolkit: {log() {}}, setTimeout};
    const player = load('src/modules/utils/pcmPlayer.ts',
        {'./prefs': utils.prefs, './notify': utils.notify, './locale': utils.locale}, globals);
    const azure = load('src/modules/tts/azure.ts',
        {'../utils/prefs': utils.prefs, '../utils/notify': utils.notify, '../utils/locale': utils.locale, '../utils/pcmPlayer': player},
        globals, 'exports.buildSsml = buildSsml;');
    const Player = class extends player.PcmStreamPlayer {constructor() {super('azure');}};
    return {Player, buildSsml: azure.buildSsml, contexts, notices, addon};
}
// 16-bit little-endian PCM samples
const pcm = (...values) => {const out = new Uint8Array(values.length * 2); const view = new DataView(out.buffer); values.forEach((v, i) => view.setInt16(i * 2, v, true)); return out;};
const endAll = context => context.sources.filter(s => !s.stopped && s.onended).forEach(s => s.onended());

test('pcm player schedules each chunk to start exactly where the previous one ends', async () => {
    const h = harness(), p = new h.Player();
    p.preloadBytes = 0;
    await p.startStream();
    const context = h.contexts[0];
    await p.queueAudioChunk(pcm(...new Array(2400).fill(0)));
    await p.queueAudioChunk(pcm(...new Array(4800).fill(0)));
    await p.queueAudioChunk(pcm(...new Array(1200).fill(0)));
    const [a, b, c] = context.sources;
    assert.equal(a.when, 0.05);
    assert.equal(b.when, a.when + a.buffer.duration);
    assert.equal(c.when, b.when + b.buffer.duration);
    assert.equal(h.contexts.length, 1);
});

test('pcm player decodes 16-bit PCM across chunks that split a sample', async () => {
    const h = harness(), p = new h.Player();
    await p.startStream();
    const bytes = pcm(16384, -32768, 32767);
    await p.queueAudioChunk(bytes.slice(0, 3));
    await p.queueAudioChunk(bytes.slice(3));
    const samples = h.contexts[0].sources.flatMap(s => s.buffer.samples);
    assert.deepEqual(samples, [0.5, -1, 32767 / 32768]);
});

test('pcm player waits for the preload amount before scheduling audio', async () => {
    const h = harness(), p = new h.Player();
    p.preloadBytes = 8;
    await p.startStream();
    await p.queueAudioChunk(pcm(1, 2));
    assert.equal(h.contexts[0].sources.length, 0);
    await p.queueAudioChunk(pcm(3, 4));
    assert.equal(h.contexts[0].sources.length, 2);
    assert.equal(h.contexts[0].gain.gain.value, 0.8);
});

test('pcm player reports completion once after the last scheduled audio ends', async () => {
    const h = harness(), p = new h.Player();
    let done = 0;
    p.setOnCompleteCallback(() => done++);
    p.preloadBytes = 1000;
    await p.startStream();
    await p.queueAudioChunk(pcm(1, 2, 3));
    await p.onSynthesisComplete();
    assert.equal(h.contexts[0].sources.length, 1, 'short text plays once synthesis is complete');
    assert.equal(done, 0);
    endAll(h.contexts[0]);
    assert.equal(done, 1);
});

test('pcm player completes immediately when the engine returned no audio', async () => {
    const h = harness(), p = new h.Player();
    let done = 0;
    p.setOnCompleteCallback(() => done++);
    await p.startStream();
    await p.onSynthesisComplete();
    assert.equal(done, 1);
});

test('pcm player stop silences scheduled audio and ignores its late end events', async () => {
    const h = harness(), p = new h.Player();
    let done = 0;
    p.setOnCompleteCallback(() => done++);
    await p.startStream();
    await p.queueAudioChunk(pcm(1, 2));
    const [source] = h.contexts[0].sources;
    const lateEnded = source.onended;
    p.stop();
    assert.equal(source.stopped, true);
    assert.equal(source.onended, null);
    lateEnded();
    assert.equal(done, 0);
    assert.equal(h.addon.data.tts.state, 'idle');
});

test('pcm player pause suspends the clock and resume continues it', async () => {
    const h = harness(), p = new h.Player();
    await p.startStream();
    await p.queueAudioChunk(pcm(1, 2));
    p.pause();
    assert.equal(h.contexts[0].state, 'suspended');
    assert.equal(h.addon.data.tts.state, 'paused');
    p.resume();
    assert.equal(h.contexts[0].state, 'running');
    assert.equal(h.addon.data.tts.state, 'playing');
});

test('pcm player pause before playback starts defers scheduling until resume', async () => {
    const h = harness(), p = new h.Player();
    p.preloadBytes = 2;
    await p.startStream();
    p.pause();
    await p.queueAudioChunk(pcm(1, 2));
    assert.equal(h.contexts[0].sources.length, 0);
    p.resume();
    assert.equal(h.contexts[0].sources.length, 1);
});

test('pcm player reports missing Web Audio instead of playing nothing', async () => {
    const h = harness({audioContext: false}), p = new h.Player();
    await assert.rejects(p.startStream(), /playback-unsupported/);
});

test('azure SSML applies the rate, escapes text and selects the language of multilingual voices', () => {
    const {buildSsml} = harness();
    const ssml = buildSsml('A < B & "C"', 'en-US-FableTurboMultilingualNeural', 'en-GB', 131);
    assert.match(ssml, /<voice name="en-US-FableTurboMultilingualNeural"><lang xml:lang="en-GB"><prosody rate="\+31%">A &lt; B &amp; &quot;C&quot;<\/prosody><\/lang><\/voice>/);
    assert.doesNotMatch(buildSsml('x', 'en-GB-SoniaNeural', 'en-GB', 100), /<lang /);
    assert.match(buildSsml('x', 'en-GB-SoniaNeural', 'en-GB', 400), /rate="\+100%"/);
    assert.match(buildSsml('x', 'en-GB-SoniaNeural', 'en-GB', 25), /rate="-50%"/);
    assert.match(buildSsml('a\u0000b', 'en-GB-SoniaNeural', 'en-GB', 100), />a b</);
});
