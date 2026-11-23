const test = require('node:test');
const assert = require('node:assert/strict');
const {load, prefs} = require('./helpers.cjs');
const tick = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
const MIME = 'audio/webm; codecs="opus"';

function harness({supported = true} = {}) {
    const sources = [], audios = [], notices = [], revoked = [];
    const urls = new Map();
    const addon = {data: {tts: {state: 'playing'}}};
    class SourceBuffer {
        constructor() {this.updating = false; this.appends = []; this.listeners = {};}
        addEventListener(type, fn) {(this.listeners[type] ??= []).push(fn);}
        appendBuffer(data) {
            if (this.updating) throw new Error('InvalidStateError: append while updating');
            this.updating = true;
            this.appends.push(Buffer.from(data).toString());
        }
        finishUpdate() {this.updating = false; (this.listeners.updateend || []).forEach(fn => fn());}
    }
    class MediaSource {
        static isTypeSupported(type) {return supported && type === MIME;}
        constructor() {this.readyState = 'closed'; this.listeners = {}; this.endCalls = 0; sources.push(this);}
        addEventListener(type, fn) {(this.listeners[type] ??= []).push(fn);}
        open() {this.readyState = 'open'; (this.listeners.sourceopen || []).forEach(fn => fn());}
        addSourceBuffer(type) {assert.equal(type, MIME); return this.buffer = new SourceBuffer();}
        endOfStream() {this.endCalls++; this.readyState = 'ended';}
    }
    class Audio {
        constructor() {this._src = ''; this.paused = true; this.plays = 0; this.playbackRate = 1; audios.push(this);}
        set src(url) {this._src = url; this.playbackRate = 1; const source = urls.get(url); if (source && this.autoOpen !== false) queueMicrotask(() => source.open());}
        get src() {return this._src;}
        play() {this.plays++; this.paused = false; return Promise.resolve();}
        pause() {this.paused = true;}
        removeAttribute(name) {if (name === 'src') this._src = '';}
        load() {}
    }
    let next = 0;
    const URL = {
        createObjectURL(source) {const url = 'blob:' + ++next; urls.set(url, source); return url;},
        revokeObjectURL(url) {revoked.push(url);},
    };
    const imports = {
        '../utils/prefs': prefs({'azure.rate': 131, 'azure.volume': 80}),
        '../utils/notify': {notifyGeneric(lines) {notices.push(lines);}},
        '../utils/locale': {getString: (id, opts) => opts?.args?.cause ?? id},
    };
    const mod = load('src/modules/tts/azure.ts', imports,
        {window: {Audio, MediaSource}, URL, addon, ztoolkit: {log() {}}, setTimeout},
        'exports.Player = AudioPlayer;');
    return {Player: mod.Player, sources, audios, notices, revoked, addon};
}
const bytes = text => new Uint8Array(Buffer.from(text));

test('azure streams all chunks into one MediaSource without overlapping appends', async () => {
    const h = harness(), p = new h.Player();
    p.minSegmentSize = 4;
    await p.startStream();
    const buffer = h.sources[0].buffer;
    await p.queueAudioChunk(bytes('ab'));
    await p.queueAudioChunk(bytes('cd'));
    await p.queueAudioChunk(bytes('ef'));
    assert.deepEqual(buffer.appends, ['ab'], 'second append must wait for updateend');
    buffer.finishUpdate();
    assert.deepEqual(buffer.appends, ['ab', 'cdef']);
    assert.equal(h.sources.length, 1, 'one stream, so no file switches');
    assert.equal(h.audios.length, 1);
});

test('azure starts playback only after the preload amount, keeping pitch at the set rate', async () => {
    const h = harness(), p = new h.Player();
    p.minSegmentSize = 6;
    await p.startStream();
    const audio = h.audios[0];
    await p.queueAudioChunk(bytes('abc'));
    assert.equal(audio.plays, 0);
    await p.queueAudioChunk(bytes('def'));
    assert.equal(audio.plays, 1);
    assert.equal(audio.playbackRate, 1.31);
    assert.equal(audio.preservesPitch, true);
    assert.equal(audio.volume, 0.8);
    await p.queueAudioChunk(bytes('ghi'));
    assert.equal(audio.plays, 1, 'later chunks extend the same playback');
});

test('azure ends the stream after the last append and reports completion once', async () => {
    const h = harness(), p = new h.Player();
    let done = 0;
    p.setOnCompleteCallback(() => done++);
    p.minSegmentSize = 100;
    await p.startStream();
    const source = h.sources[0], audio = h.audios[0];
    await p.queueAudioChunk(bytes('short'));
    await p.onSynthesisComplete();
    assert.equal(audio.plays, 1, 'short text plays once synthesis is complete');
    assert.equal(source.endCalls, 0, 'endOfStream waits for the pending append');
    source.buffer.finishUpdate();
    assert.equal(source.endCalls, 1);
    audio.onended();
    assert.equal(done, 1);
    assert.equal(h.revoked.length, 1);
});

test('azure stop while the MediaSource opens does not hang, and stale events are ignored', async () => {
    const h = harness(), p = new h.Player();
    let done = 0;
    p.setOnCompleteCallback(() => done++);
    await p.initialize();
    h.audios[0].autoOpen = false;
    const starting = p.startStream();
    await tick();
    const staleEnded = h.audios[0].onended;
    p.stop();
    await starting;
    staleEnded();
    assert.equal(done, 0);
    assert.equal(h.addon.data.tts.state, 'idle');
});

test('azure pause before playback starts defers the start until resume', async () => {
    const h = harness(), p = new h.Player();
    p.minSegmentSize = 2;
    await p.startStream();
    p.pause();
    await p.queueAudioChunk(bytes('abcd'));
    assert.equal(h.audios[0].plays, 0);
    p.resume();
    assert.equal(h.audios[0].plays, 1);
    assert.equal(h.addon.data.tts.state, 'playing');
});

test('azure reports unsupported WebM streaming instead of playing nothing', async () => {
    const h = harness({supported: false}), p = new h.Player();
    await assert.rejects(p.startStream(), /playback-unsupported/);
});

test('azure append failure stops playback and notifies', async () => {
    const h = harness(), p = new h.Player();
    await p.startStream();
    h.sources[0].buffer.appendBuffer = () => {throw new Error('QuotaExceededError');};
    await p.queueAudioChunk(bytes('x'));
    assert.equal(h.addon.data.tts.state, 'idle');
    assert.equal(h.notices.at(-1)[1], 'playback-failed');
});
