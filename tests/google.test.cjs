const test = require('node:test');
const assert = require('node:assert/strict');
const {load, prefs} = require('./helpers.cjs');
const tick = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};

// A 24 kHz mono 16-bit WAV, as Google returns for LINEAR16
function wav(samples, extraChunk = false) {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
    const chunks = [];
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(24000, 12); fmt.writeUInt32LE(48000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
    chunks.push(fmt);
    if (extraChunk) {const list = Buffer.alloc(11); list.write('LIST', 0); list.writeUInt32LE(3, 4); chunks.push(list, Buffer.alloc(1));}
    const head = Buffer.alloc(8); head.write('data', 0); head.writeUInt32LE(data.length, 4);
    chunks.push(head, data);
    const body = Buffer.concat(chunks);
    const riff = Buffer.alloc(12); riff.write('RIFF', 0); riff.writeUInt32LE(body.length + 4, 4); riff.write('WAVE', 8);
    return Buffer.concat([riff, body]);
}

function harness(values = {}) {
    const requests = [], notices = [], contexts = [];
    const addon = {data: {tts: {state: 'idle'}}};
    class AudioContext {
        constructor() {this.currentTime = 0; this.state = 'running'; this.sources = []; this.destination = {}; contexts.push(this);}
        createGain() {return {gain: {value: 1}, connect() {}};}
        createBuffer(channels, length, sampleRate) {return {length, duration: length / sampleRate, copyToChannel(s) {this.samples = Array.from(s);}};}
        createBufferSource() {const c = this; return {connect() {}, start(when) {this.when = when; c.sources.push(this);}, stop() {this.stopped = true;}};}
        suspend() {this.state = 'suspended'; return Promise.resolve();}
        resume() {this.state = 'running'; return Promise.resolve();}
        close() {return Promise.resolve();}
    }
    const preferences = prefs({'google.apiKey': 'test-key', 'google.language': 'en-GB', 'google.voice': 'en-GB-Neural2-A', 'google.rate': 131, 'google.volume': 100, ...values});
    const utils = {
        '../utils/prefs': preferences,
        '../utils/notify': {notifyGeneric(lines) {notices.push(lines);}},
        '../utils/locale': {getString: (id, opts) => opts?.args?.cause ?? id},
    };
    const window = {AudioContext, AbortController, atob: s => Buffer.from(s, 'base64').toString('binary')};
    const globals = {window, addon, ztoolkit: {log() {}}, setTimeout, Components: undefined,
        fetch(url, options) {
            let resolve, reject;
            const promise = new Promise((a, b) => {resolve = a; reject = b;});
            options?.signal?.addEventListener('abort', () => {const e = new Error('aborted'); e.name = 'AbortError'; reject(e);});
            requests.push({url, options, body: options?.body ? JSON.parse(options.body) : null, resolve, reject});
            return promise;
        }};
    const player = load('src/modules/utils/pcmPlayer.ts', {'./prefs': preferences, './notify': utils['../utils/notify'], './locale': utils['../utils/locale']}, globals);
    const mod = load('src/modules/tts/google.ts', {...utils, '../utils/pcmPlayer': player}, globals,
        'exports.splitSections = splitSections; exports.extractWavPcm = extractWavPcm; exports.speakingRateFor = speakingRateFor;');
    const respond = (i, samples) => requests[i].resolve({ok: true, json: async () => ({audioContent: wav(samples).toString('base64')})});
    const fail = (i, status) => requests[i].resolve({ok: false, status, statusText: 'err', text: async () => 'denied'});
    return {mod, requests, notices, contexts, addon, respond, fail};
}

test('google splits text into a short first section and sentence-aligned sections under the request limit', () => {
    const {mod} = harness();
    const sentence = 'This sentence is about sixty characters long, more or less. ';
    const text = sentence.repeat(80);
    const sections = mod.splitSections(text);
    assert.equal(sections.join(''), text);
    assert.ok(sections[0].length <= 450 && sections[0].length > 150, `first section ${sections[0].length}`);
    for (const section of sections) {
        assert.ok(Buffer.byteLength(section) < 5000);
        assert.match(section, /\. $/, 'sections end at a sentence boundary');
    }
    const noBoundary = 'word '.repeat(2000);
    assert.equal(mod.splitSections(noBoundary).join(''), noBoundary);
    assert.deepEqual(Array.from(mod.splitSections('Short text.')), ['Short text.']);
});

test('google strips the WAV header, including extra chunks, from LINEAR16 audio', () => {
    const {mod} = harness();
    const pcm = mod.extractWavPcm(new Uint8Array(wav([1, -2, 3], true)));
    assert.deepEqual(Array.from(new Int16Array(pcm.slice().buffer)), [1, -2, 3]);
    const raw = new Uint8Array([1, 2, 3, 4]);
    assert.equal(mod.extractWavPcm(raw), raw, 'data without a WAV header is passed through');
});

test('google keeps the speaking rate inside the limits of the voice', () => {
    const {mod} = harness();
    assert.equal(mod.speakingRateFor('en-GB-Neural2-A', 131), 1.31);
    assert.equal(mod.speakingRateFor('en-GB-Neural2-A', 400), 4);
    assert.equal(mod.speakingRateFor('en-US-Chirp3-HD-Charon', 300), 2);
    assert.equal(mod.speakingRateFor('en-GB-Neural2-A', 10), 0.25);
});

test('google requests LINEAR16 sections in order and plays them as one gapless stream', async () => {
    const h = harness();
    const text = 'First sentence is here. '.repeat(20) + 'Second part follows now. '.repeat(50);
    h.mod.speak(text);
    await tick();
    assert.equal(h.requests.length, 1, 'only one section is synthesized at a time');
    const [first] = h.requests;
    assert.equal(first.url, 'https://texttospeech.googleapis.com/v1/text:synthesize');
    assert.equal(first.options.headers['X-Goog-Api-Key'], 'test-key');
    assert.deepEqual(first.body.voice, {languageCode: 'en-GB', name: 'en-GB-Neural2-A'});
    assert.deepEqual(first.body.audioConfig, {audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: 1.31});
    assert.equal(h.addon.data.tts.state, 'playing');

    h.respond(0, new Array(2400).fill(0));
    await tick();
    assert.equal(h.requests.length, 2);
    h.respond(1, new Array(4800).fill(0));
    await tick();
    const sources = h.contexts[0].sources;
    assert.equal(sources.length, 2);
    assert.equal(sources[1].when, sources[0].when + sources[0].buffer.duration);
    // Answer the remaining sections until no new request follows
    for (let answered = 2; answered < h.requests.length; answered++) {
        h.respond(answered, [0]);
        await tick();
    }
    const joined = h.requests.map(r => r.body.input.text).join('');
    assert.equal(joined, text, 'all text is requested exactly once, in order');
    sources.forEach(s => s.onended?.());
    assert.equal(h.addon.data.tts.state, 'idle');
});

test('google reports an invalid key and stops', async () => {
    const h = harness();
    h.mod.speak('Hello there.');
    await tick();
    h.fail(0, 403);
    await tick();
    assert.equal(h.notices.at(-1)[1], 'auth-failed');
    assert.equal(h.addon.data.tts.state, 'idle');
});

test('google stop cancels the request in flight without an error message', async () => {
    const h = harness();
    h.mod.speak('Hello there.');
    await tick();
    h.mod.stop();
    await tick();
    assert.equal(h.notices.length, 0);
    assert.equal(h.addon.data.tts.state, 'idle');
});

test('google asks for configuration when no voice is selected', async () => {
    const h = harness({'google.voice': ''});
    h.mod.speak('Hello there.');
    await tick();
    assert.equal(h.requests.length, 0);
    assert.equal(h.notices.at(-1)[1], 'config-incomplete');
});

test('google lists languages and voices from the voices API', async () => {
    const h = harness();
    const voices = [
        {name: 'en-GB-Neural2-A', languageCodes: ['en-GB']},
        {name: 'de-DE-Neural2-B', languageCodes: ['de-DE']},
        {name: 'en-GB-Chirp3-HD-Charon', languageCodes: ['en-GB']},
    ];
    const pending = h.mod.getAllVoices();
    await tick();
    assert.equal(h.requests[0].url, 'https://texttospeech.googleapis.com/v1/voices');
    h.requests[0].resolve({ok: true, json: async () => ({voices})});
    const result = await pending;
    assert.equal(result.success, true);
    assert.deepEqual(Array.from(h.mod.extractLanguages(result.voices)), ['de-DE', 'en-GB']);
    assert.deepEqual(Array.from(h.mod.filterVoicesByLanguage(result.voices, 'en-GB')), ['en-GB-Chirp3-HD-Charon', 'en-GB-Neural2-A']);
});
