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

class VoiceModule {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        
        // TTS backend selection
        this.backend = config.voice?.backend || 'kokoro';
        this.enabled = config.voice?.enabled !== false;

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
                outputDevice: config.voice?.piper?.outputDevice || 'default'
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
            const proc = spawn(kokoroConfig.command, [kokoroConfig.script, '--server', '--lang', defaultLang]);
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
     * Speak text using configured backend
     */
    async speak(text, options = {}) {
        if (!this.enabled || !text) {
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
     * Speak with Piper TTS
     */
    async speakWithPiper(text, options) {
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
            ]);
            
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
            
            const process = spawn('espeak', args);
            
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
    }

    /**
     * Queue important announcement
     */
    announce(text, priority = 'normal') {
        if (priority === 'high') {
            // Insert at beginning of queue
            this.queue.unshift({ text: textUtils.formatTextForTTS(text, this.lang), options: { priority } });

            // Make sure the queue is actually being drained even if nothing is speaking
            if (!this.speaking) {
                this.processQueue();
            }
        } else {
            this.speak(text, { priority });
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
