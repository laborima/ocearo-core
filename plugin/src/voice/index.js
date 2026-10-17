/**
 * Voice/TTS Module
 *
 * Handles text-to-speech output via multiple backends:
 * - Piper TTS (default, high quality neural TTS for RPi5)
 * - eSpeak-ng (lightweight fallback)
 * - Console (debug/headless mode)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { textUtils } = require('../common');

/**
 * Environment for the audio players. Signal K runs as a system service,
 * without the desktop session's XDG_RUNTIME_DIR: aplay then opens the sound
 * card directly, which fails ("device busy") while PipeWire is using it for a
 * browser, and never reaches a Bluetooth speaker. Pointing it at the session
 * of the same user makes ALSA's default device go through PipeWire.
 */
const audioEnv = (() => {
    const env = { ...process.env };
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const runDir = uid !== null ? `/run/user/${uid}` : null;
    if (!env.XDG_RUNTIME_DIR && runDir && fs.existsSync(runDir)) {
        env.XDG_RUNTIME_DIR = runDir;
        if (!env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(`${runDir}/bus`)) {
            env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runDir}/bus`;
        }
    }
    return env;
})();

class VoiceModule {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        
        // TTS backend selection
        this.backend = config.voice?.backend || 'kokoro';
        this.enabled = config.voice?.enabled !== false;

        // Do-not-disturb: 'off' | 'safety' (only critical/safety-tagged) | 'all' (silence)
        this.dndMode = 'off';

        // Language used for TTS formatting (defaults to config language)
        this.lang = config.language || 'en';
        
        // Resolve Kokoro command with fallbacks if venv python is missing
        const kokoroCommand = fs.existsSync('/opt/kokoro/venv/bin/python3')
            ? '/opt/kokoro/venv/bin/python3'
            : (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');

        const kokoroScript = fs.existsSync('/opt/kokoro/ocearo-tts.py')
            ? '/opt/kokoro/ocearo-tts.py'
            : path.join(__dirname, '../../scripts/ocearo-tts.py');

        // Backend specific settings
        this.backends = {
            kokoro: {
                command: kokoroCommand,
                script: kokoroScript,
                voiceEn: config.voice?.kokoroVoiceEn || 'af_heart',
                voiceFr: config.voice?.kokoroVoiceFr || 'ff_siwis',
                speed: config.voice?.kokoroSpeed || 1.0
            },
            piper: {
                command: config.voice?.piper?.command || 'piper',
                model: config.voice?.piper?.model || (config.language === 'fr' ? 'fr_FR-tom-medium' : 'en_US-joe-medium'),
                modelPath: config.voice?.piper?.modelPath || '/opt/piper',
                speed: config.voice?.piper?.speed || 1.0,
                outputDevice: config.voice?.piper?.outputDevice || 'default',
                // Python of the Piper install (piper-tts >= 1.3): with it the
                // voice stays loaded in a server (scripts/ocearo-piper-server.py)
                python: config.voice?.piper?.python || '/opt/piper/venv/bin/python3',
                server: config.voice?.piper?.server !== false,
                utteranceTimeoutSeconds: config.voice?.piper?.utteranceTimeoutSeconds || 60
            },
            espeak: {
                command: 'espeak-ng',
                voice: config.voice?.espeak?.voice || 'en',
                speed: config.voice?.espeak?.speed || 175,
                pitch: config.voice?.espeak?.pitch || 50,
                outputDevice: config.voice?.espeak?.outputDevice || 'default'
            },
            console: {
                prefix: config.voice?.console?.prefix || '🗣️ JARVIS:'
            }
        };
        
        // Voice queue to prevent overlapping speech
        this.queue = [];
        this.speaking = false;

        // Persistent Kokoro daemon (keeps the ONNX model resident between utterances)
        this.kokoroProc = null;
        this._kokoroReady = false;
        this._kokoroBuffer = '';
        this._kokoroPending = null; // { resolve, timer }

        // Persistent Piper server (same protocol as the Kokoro daemon)
        this.piperProc = null;
        this._piperBuffer = '';
        this._piperPending = null; // { resolve, timer }
        this._piperServerFailed = false;
        
        // Test TTS backend availability (non-blocking)
        this.testBackend().catch(error => {
            this.app.debug('Voice backend test failed during initialization, will retry on first use:', error.message);
        });
    }

    /**
     * Start the voice module
     */
    start() {
        this.app.debug('Voice module started');
        return Promise.resolve();
    }

    /**
     * Test TTS backend availability
     */
    async testBackend() {
        if (!this.enabled) {
            this.app.debug('Voice module disabled');
            return;
        }
        
        try {
            switch (this.backend) {
                case 'kokoro':
                    await this.testKokoro();
                    break;
                case 'piper':
                    await this.testPiper();
                    break;
                case 'espeak':
                    await this.testEspeak();
                    break;
                case 'console':
                    this.app.debug('Using console output for TTS');
                    break;
                default:
                    this.app.error(`Unknown TTS backend: ${this.backend}`);
                    this.backend = 'console';
            }
        } catch (error) {
            const backend = this.backend;
            this.backend = 'console';

            // Provide detailed error information
            this.app.error(`TTS Backend '${backend}' Failed: ${error.message}`);

            if (backend === 'piper') {
                this.app.error(
                    'Piper TTS is not working. Solutions:\n' +
                    '1. Install Piper: https://github.com/rhasspy/piper/releases\n' +
                    '2. Add to PATH or update config: voice.piper.command\n' +
                    '3. Make executable: chmod +x /path/to/piper\n' +
                    '4. Download voice: piper --download-voice en en_US-amy-medium\n' +
                    '5. Or switch to eSpeak: set voice.backend to "espeak"'
                );
            } else if (backend === 'espeak') {
                this.app.error(
                    'eSpeak TTS is not working. Solutions:\n' +
                    '1. Install eSpeak: sudo apt-get install espeak espeak-ng\n' +
                    '2. Check audio permissions and drivers\n' +
                    '3. Or switch to console: set voice.backend to "console"'
                );
            }

            this.app.debug(`TTS backend ${backend} unavailable, using console fallback`);
        }
    }

    /**
     * Test Kokoro availability
     */
    async testKokoro() {
        return new Promise((resolve, reject) => {
            const kokoroConfig = this.backends.kokoro;
            const testProcess = spawn(kokoroConfig.command, [kokoroConfig.script, '--help']);

            testProcess.on('error', (error) => {
                reject(new Error(`Kokoro TTS not available: ${error.message}`));
            });

            testProcess.on('close', (code) => {
                if (code === 0 || code === 2) {
                    resolve();
                } else {
                    reject(new Error(`Kokoro TTS test failed with exit code ${code}`));
                }
            });
        });
    }

    /**
     * Ensure the persistent Kokoro daemon is running.
     * Spawns it once (model loads once) and wires up stdout marker parsing.
     * @returns {boolean} true if a daemon process is available
     */
    _ensureKokoroDaemon() {
        if (this.kokoroProc && !this.kokoroProc.killed) {
            return true;
        }

        const kokoroConfig = this.backends.kokoro;
        const defaultLang = this.lang === 'fr' ? 'fr-fr' : 'en-us';

        try {
            this.app.debug(`Starting Kokoro daemon: ${kokoroConfig.command} ${kokoroConfig.script} --server`);
            const proc = spawn(kokoroConfig.command, [kokoroConfig.script, '--server', '--lang', defaultLang], { env: audioEnv });
            this.kokoroProc = proc;
            this._kokoroReady = false;
            this._kokoroBuffer = '';

            proc.stdout.on('data', (data) => this._onKokoroStdout(data));
            proc.stderr.on('data', (data) => this.app.debug(`Kokoro stderr: ${data.toString().trim()}`));

            proc.on('error', (error) => {
                this.app.error(`Kokoro daemon error: ${error.message}`);
                this._teardownKokoro('error');
            });
            proc.on('exit', (code) => {
                this.app.debug(`Kokoro daemon exited (code ${code})`);
                this._teardownKokoro('exit');
            });

            return true;
        } catch (error) {
            this.app.error(`Failed to start Kokoro daemon: ${error.message}`);
            this.kokoroProc = null;
            return false;
        }
    }

    /**
     * Parse daemon stdout, resolving the in-flight utterance on a marker line.
     */
    _onKokoroStdout(data) {
        this._kokoroBuffer += data.toString();
        let idx;
        while ((idx = this._kokoroBuffer.indexOf('\n')) !== -1) {
            const line = this._kokoroBuffer.slice(0, idx).trim();
            this._kokoroBuffer = this._kokoroBuffer.slice(idx + 1);
            if (line === '__OCEARO_TTS__:ready') {
                this._kokoroReady = true;
            } else if (line === '__OCEARO_TTS__:done' || line === '__OCEARO_TTS__:error') {
                this._resolveKokoroPending();
            }
        }
    }

    /**
     * Resolve the current pending utterance promise (and clear its watchdog).
     */
    _resolveKokoroPending() {
        if (this._kokoroPending) {
            clearTimeout(this._kokoroPending.timer);
            const { resolve } = this._kokoroPending;
            this._kokoroPending = null;
            resolve();
        }
    }

    /**
     * Tear down the daemon and release any waiter so the queue keeps draining.
     */
    _teardownKokoro() {
        this.kokoroProc = null;
        this._kokoroReady = false;
        this._kokoroBuffer = '';
        this._resolveKokoroPending();
    }

    /**
     * Speak with the persistent Kokoro TTS daemon.
     */
    async speakWithKokoro(text, options) {
        const kokoroConfig = this.backends.kokoro;
        const lang = this.lang === 'fr' ? 'fr-fr' : 'en-us';
        const voice = this.lang === 'fr'
            ? (options.voice || kokoroConfig.voiceFr)
            : (options.voice || kokoroConfig.voiceEn);
        const speed = options.speed || kokoroConfig.speed;

        if (!this._ensureKokoroDaemon()) {
            // Daemon unavailable — fall back to console so announcements aren't lost.
            return this.speakToConsole(text);
        }

        return new Promise((resolve) => {
            // Watchdog: if the daemon hangs, recover instead of blocking the queue forever.
            const timer = setTimeout(() => {
                this.app.error('Kokoro daemon timed out; restarting on next utterance');
                this._kokoroPending = null;
                try { this.kokoroProc?.kill(); } catch { /* ignore */ }
                this._teardownKokoro('timeout');
                resolve();
            }, (kokoroConfig.utteranceTimeoutSeconds || 30) * 1000);

            this._kokoroPending = { resolve, timer };

            const request = JSON.stringify({ text, voice, speed, lang }) + '\n';
            try {
                this.kokoroProc.stdin.write(request);
                this.app.debug(`Kokoro queued: "${text.substring(0, 50)}..."`);
            } catch (error) {
                this.app.error(`Kokoro write failed: ${error.message}`);
                this._resolveKokoroPending();
            }
        });
    }

    /**
     * Test Piper availability
     */
    async testPiper() {
        return new Promise((resolve, reject) => {
            const piperCmd = this.backends.piper.command;

            // First check if the command exists
            const which = spawn('which', [piperCmd]);

            which.on('error', () => {
                reject(new Error(
                    `Piper TTS not found! Please install Piper:\n` +
                    `1. Download from: https://github.com/rhasspy/piper/releases\n` +
                    `2. Extract to /usr/local/bin/ or add to PATH\n` +
                    `3. Make executable: chmod +x piper\n` +
                    `4. Download voice model: piper --download-voice en en_US-amy-medium\n` +
                    `Looking for: ${piperCmd}`
                ));
            });

            which.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(
                        `Piper command '${piperCmd}' not found in PATH!\n` +
                        `Please install Piper or update the 'voice.piper.command' config.\n` +
                        `Current config: "${piperCmd}"`
                    ));
                }
            });

            // If which succeeds, test Piper functionality
            which.on('close', (code) => {
                if (code === 0) {
                    // Piper exists, now test with help flag (doesn't require model)
                    const testProcess = spawn(piperCmd, ['--help']);

                    testProcess.on('error', (error) => {
                        reject(new Error(
                            `Piper found but failed to run: ${error.message}\n` +
                            `Command: ${piperCmd}\n` +
                            `Check file permissions: chmod +x ${piperCmd}`
                        ));
                    });

                    testProcess.on('close', (testCode) => {
                        if (testCode === 0) {
                            resolve();
                        } else {
                            reject(new Error(
                                `Piper test failed with exit code ${testCode}\n` +
                                `Command: ${piperCmd} --help\n` +
                                `Piper is installed but may be missing dependencies or incompatible.\n` +
                                `Try running manually to see the error`
                            ));
                        }
                    });
                }
            });
        });
    }

    /**
     * Test eSpeak availability
     */
    async testEspeak() {
        return new Promise((resolve, reject) => {
            // Test eSpeak availability
            const espeakProcess = spawn('espeak', ['--version']);

            espeakProcess.on('error', (error) => {
                if (error.code === 'ENOENT') {
                    reject(new Error(
                        `eSpeak TTS not installed! Please install eSpeak:\n` +
                        `Ubuntu/Debian: sudo apt-get install espeak espeak-ng\n` +
                        `CentOS/RHEL: sudo yum install espeak\n` +
                        `macOS: brew install espeak\n` +
                        `Windows: Download from: https://espeak.sourceforge.net/download.html\n` +
                        `Error: ${error.message}`
                    ));
                } else {
                    reject(new Error(
                        `eSpeak TTS error: ${error.message}\n` +
                        `This might be a permissions issue or missing dependencies.\n` +
                        `Try running: espeak "test"`
                    ));
                }
            });

            espeakProcess.on('close', (code) => {
                if (code === 0) {
                    this.app.debug('eSpeak TTS backend available');
                    resolve();
                } else {
                    reject(new Error(
                        `eSpeak test failed with exit code ${code}\n` +
                        `This usually means:\n` +
                        `1. Audio output device issues\n` +
                        `2. Missing audio libraries (alsa/pulseaudio)\n` +
                        `3. Permission issues with audio devices\n` +
                        `Try running: espeak --version`
                    ));
                }
            });
        });
    }

    /**
     * Set do-not-disturb mode: 'off' | 'safety' | 'all'.
     * 'safety' lets only safety-tagged or critical-priority messages through,
     * 'all' silences everything. Pending queue is dropped on activation.
     */
    setDnd(mode) {
        this.dndMode = mode;
        if (mode !== 'off') {
            this.queue = [];
        }
    }

    _dndBlocks(options = {}) {
        if (this.dndMode === 'off') return false;
        if (this.dndMode === 'all') return true;
        return !(options.safety === true || options.priority === 'critical');
    }

    /**
     * Speak text using configured backend
     */
    async speak(text, options = {}) {
        if (!this.enabled || !text || this._dndBlocks(options)) {
            return;
        }
        
        // Format text for TTS
        const formattedText = textUtils.formatTextForTTS(text, this.lang);
        
        // Add to queue
        this.queue.push({ text: formattedText, options });
        
        // Process queue if not already speaking
        if (!this.speaking) {
            this.processQueue();
        }
    }

    /**
     * Process speech queue
     */
    async processQueue() {
        if (this.queue.length === 0) {
            this.speaking = false;
            return;
        }
        
        this.speaking = true;
        const { text, options } = this.queue.shift();
        
        try {
            switch (this.backend) {
                case 'kokoro':
                    await this.speakWithKokoro(text, options);
                    break;
                case 'piper':
                    await this.speakWithPiper(text, options);
                    break;
                case 'espeak':
                    await this.speakWithEspeak(text, options);
                    break;
                case 'console':
                default:
                    await this.speakToConsole(text, options);
                    break;
            }
        } catch (error) {
            this.app.error('Speech failed:', error);
        }
        
        // Continue with next item
        setTimeout(() => this.processQueue(), 500);
    }

    /**
     * Resolve a Piper model's playback sample rate.
     * Reads the model's companion JSON (`<model>.onnx.json`, field audio.sample_rate)
     * once and caches it. Falls back to 22050 Hz (the rate of Piper *medium* voices).
     * This avoids the wrong-pitch/too-fast playback caused by hard-coding the rate.
     * @param {string} modelFile  full path to the .onnx model
     * @returns {string} sample rate as a string for aplay -r
     */
    _piperSampleRate(modelFile) {
        if (!this._piperSampleRates) this._piperSampleRates = {};
        if (this._piperSampleRates[modelFile]) return this._piperSampleRates[modelFile];

        let rate = 22050;
        try {
            const cfg = JSON.parse(fs.readFileSync(`${modelFile}.json`, 'utf8'));
            if (cfg.audio?.sample_rate) rate = cfg.audio.sample_rate;
        } catch (e) {
            this.app.debug(`Piper: could not read sample rate from ${modelFile}.json, using ${rate} Hz`);
        }
        this._piperSampleRates[modelFile] = String(rate);
        return this._piperSampleRates[modelFile];
    }

    /**
     * Speak with Piper TTS: through the resident server when the Piper Python
     * is there, else one `piper` process per utterance.
     */
    async speakWithPiper(text, options) {
        const piperConfig = this.backends.piper;
        if (piperConfig.server && !this._piperServerFailed && fs.existsSync(piperConfig.python)) {
            if (this._ensurePiperServer()) return this._speakWithPiperServer(text, options);
        }
        return this._speakWithPiperOnce(text, options);
    }

    /**
     * Start the Piper server once: the voice model is loaded a single time
     * instead of on every utterance (about 4.5 s saved per announcement on a
     * Raspberry Pi 5).
     * @returns {boolean} true if a server process is available
     */
    _ensurePiperServer() {
        if (this.piperProc && !this.piperProc.killed) return true;
        const piperConfig = this.backends.piper;
        const script = path.join(__dirname, '..', '..', 'scripts', 'ocearo-piper-server.py');
        const modelFile = path.join(piperConfig.modelPath || '/opt/piper', `${piperConfig.model}.onnx`);
        try {
            const args = [script, '--model', modelFile, '--device', piperConfig.outputDevice || 'default'];
            this.app.debug(`Starting Piper server: ${piperConfig.python} ${args.join(' ')}`);
            const proc = spawn(piperConfig.python, args, { env: audioEnv });
            this.piperProc = proc;
            this._piperBuffer = '';
            // Events of a server already replaced (killed by the watchdog, then a new one
            // started) must not touch the current one
            const current = () => this.piperProc === proc;
            proc.stdout.on('data', (data) => { if (current()) this._onPiperStdout(data); });
            proc.stderr.on('data', (data) => this.app.debug(`Piper server: ${data.toString().trim()}`));
            proc.on('error', (error) => {
                this.app.error(`Piper server error: ${error.message}`);
                if (!current()) return;
                this._piperServerFailed = true;
                this._teardownPiper();
            });
            proc.on('exit', (code) => {
                this.app.debug(`Piper server exited (code ${code})`);
                if (!current()) return;
                // Died before its first answer: not usable here, back to one-shot
                if (!this._piperReady) this._piperServerFailed = true;
                this._teardownPiper();
            });
            this._piperReady = false;
            return true;
        } catch (error) {
            this.app.error(`Failed to start the Piper server: ${error.message}`);
            this._piperServerFailed = true;
            this.piperProc = null;
            return false;
        }
    }

    _onPiperStdout(data) {
        this._piperBuffer += data.toString();
        let idx;
        while ((idx = this._piperBuffer.indexOf('\n')) !== -1) {
            const line = this._piperBuffer.slice(0, idx).trim();
            this._piperBuffer = this._piperBuffer.slice(idx + 1);
            if (line === '__OCEARO_TTS__:ready') {
                this._piperReady = true;
            } else if (line === '__OCEARO_TTS__:done' || line === '__OCEARO_TTS__:error') {
                this._resolvePiperPending();
            }
        }
    }

    _resolvePiperPending() {
        if (this._piperPending) {
            clearTimeout(this._piperPending.timer);
            const { resolve } = this._piperPending;
            this._piperPending = null;
            resolve();
        }
    }

    _teardownPiper() {
        this.piperProc = null;
        this._piperReady = false;
        this._piperBuffer = '';
        this._resolvePiperPending();
    }

    _speakWithPiperServer(text, options) {
        const piperConfig = this.backends.piper;
        return new Promise((resolve) => {
            // Watchdog: a hung server must not block the announcements behind it
            const timer = setTimeout(() => {
                this.app.error('Piper server timed out; restarting on next utterance');
                this._piperPending = null;
                try { this.piperProc?.kill(); } catch { /* ignore */ }
                this._teardownPiper();
                resolve();
            }, piperConfig.utteranceTimeoutSeconds * 1000);
            this._piperPending = {
                resolve: () => { this.app.debug(`Piper Spoke: "${text}"`); resolve(); },
                timer
            };
            const lengthScale = options.speed || piperConfig.speed || 1.0;
            try {
                this.piperProc.stdin.write(JSON.stringify({ text, length_scale: lengthScale }) + '\n');
            } catch (error) {
                this.app.error(`Piper server write failed: ${error.message}`);
                this._resolvePiperPending();
            }
        });
    }

    /**
     * Speak with Piper TTS, one process per utterance (model loaded each time)
     */
    async _speakWithPiperOnce(text, options) {
        const piperConfig = this.backends.piper;
        const modelDir = piperConfig.modelPath || '/opt/piper';
        const modelFile = path.join(modelDir, `${piperConfig.model}.onnx`);
        const sampleRate = this._piperSampleRate(modelFile);

        return new Promise((resolve, reject) => {
            const args = [
                '--model', modelFile,
                '--output-raw'
            ];

            const speed = options.speed || piperConfig.speed;
            if (speed && speed !== 1.0) {
                args.push('--length-scale', String(speed));
            }

            // Log the command being executed
            const commandStr = `${piperConfig.command} ${args.join(' ')} | aplay -r ${sampleRate} -f S16_LE -t raw -`;
            this.app.debug(`Executing Piper command: ${commandStr}`);

            const piper = spawn(piperConfig.command, args);
            const aplay = spawn('aplay', [
                '-r', sampleRate,
                '-f', 'S16_LE',
                '-t', 'raw',
                '-'
            ], { env: audioEnv });
            
            piper.stdout.pipe(aplay.stdin);
            
            piper.on('error', reject);
            aplay.on('error', reject);
            
            aplay.on('close', async () => {
                this.app.debug(`Piper Spoke: "${text}"`);
                
                resolve();
            });
            
            // Send text to Piper
            piper.stdin.write(text);
            piper.stdin.end();
        });
    }

    /**
     * Speak with eSpeak TTS
     */
    async speakWithEspeak(text, options) {
        const espeakConfig = this.backends.espeak;
        
        return new Promise((resolve, reject) => {
            const args = [
                '-v', options.voice || espeakConfig.voice,
                '-s', String(options.speed || espeakConfig.speed),
                '-p', String(options.pitch || espeakConfig.pitch),
                text
            ];
            
            const process = spawn('espeak', args, { env: audioEnv });
            
            process.on('error', reject);
            
            process.on('close', (code) => {
                if (code === 0) {
                    this.app.debug(`Spoke: "${text.substring(0, 50)}..."`);
                    resolve();
                } else {
                    reject(new Error(`eSpeak failed with code ${code}`));
                }
            });
        });
    }

    /**
     * Output to console
     */
    async speakToConsole(text) {
        const prefix = this.backends.console.prefix;
        console.log(`${prefix} ${text}`);
        this.app.debug(`Console TTS: "${text.substring(0, 50)}..."`);
        
        // Simulate speaking time
        const words = text.split(' ').length;
        const speakTime = (words / 3) * 1000; // ~3 words per second
        await new Promise(resolve => setTimeout(resolve, Math.min(speakTime, 5000)));
    }

    /**
     * Stop speaking and clear queue
     */
    stop() {
        this.queue = [];
        this._resolveKokoroPending();
        if (this.kokoroProc && !this.kokoroProc.killed) {
            try {
                this.kokoroProc.stdin.end();
                this.kokoroProc.kill();
            } catch { /* ignore */ }
        }
        this.kokoroProc = null;
        this._kokoroReady = false;
        this._resolvePiperPending();
        if (this.piperProc && !this.piperProc.killed) {
            try {
                this.piperProc.stdin.end();
                this.piperProc.kill();
            } catch { /* ignore */ }
        }
        this.piperProc = null;
        this._piperReady = false;
    }

    /**
     * Queue important announcement
     */
    announce(text, priority = 'normal', options = {}) {
        const opts = { ...options, priority };
        if (this._dndBlocks(opts)) {
            return;
        }
        if (priority === 'high') {
            // Insert at beginning of queue
            this.queue.unshift({ text: textUtils.formatTextForTTS(text, this.lang), options: opts });

            // Make sure the queue is actually being drained even if nothing is speaking
            if (!this.speaking) {
                this.processQueue();
            }
        } else {
            this.speak(text, opts);
        }
    }

    /**
     * Get queue status
     */
    getStatus() {
        return {
            enabled: this.enabled,
            backend: this.backend,
            speaking: this.speaking,
            queueLength: this.queue.length
        };
    }

    /**
     * Update voice settings
     */
    updateSettings(settings) {
        if (settings.enabled !== undefined) {
            this.enabled = settings.enabled;
        }
        
        if (settings.backend && settings.backend !== this.backend) {
            this.backend = settings.backend;
            this.testBackend();
        }
        
        // Update backend specific settings
        if (settings.piper) {
            Object.assign(this.backends.piper, settings.piper);
        }
        
        if (settings.espeak) {
            Object.assign(this.backends.espeak, settings.espeak);
        }
    }
}

module.exports = VoiceModule;
