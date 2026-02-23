/**
 * Voice/TTS Module
 *
 * Handles text-to-speech output via multiple backends:
 * - Piper TTS (default, high quality neural TTS for RPi5)
 * - eSpeak-ng (lightweight fallback)
 * - Console (debug/headless mode)
 */

const { spawn } = require('child_process');
const { textUtils } = require('../common');

class VoiceModule {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        
        // TTS backend selection
        this.backend = config.voice?.backend || 'piper';
        this.enabled = config.voice?.enabled !== false;
        
        // Backend specific settings
        this.backends = {
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
        const formattedText = textUtils.formatTextForTTS(text);
        
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
     * Speak with Piper TTS
     */
    async speakWithPiper(text, options) {
        const piperConfig = this.backends.piper;
        
        return new Promise((resolve, reject) => {
            const args = [
                '--model', "/opt/piper/"+piperConfig.model+".onnx",
                '--output-raw'
            ];
            
            if (options.speed || piperConfig.speed !== 1.0) {
                const speed = options.speed || piperConfig.speed;
                args.push('--length-scale', String(speed));
            }
            
            // Log the command being executed
            const commandStr = `${piperConfig.command} ${args.join(' ')} | aplay -r ${piperConfig.model.startsWith('fr_') ? '44100' : '22050'} -f S16_LE -t raw -`;
            this.app.debug(`Executing Piper command: ${commandStr}`);
            
            const piper = spawn(piperConfig.command, args);
            const sampleRate = piperConfig.model.startsWith('fr_') ? '44100' : '22050';
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
        // TODO: Implement actual audio stopping for backends
    }

    /**
     * Queue important announcement
     */
    announce(text, priority = 'normal') {
        if (priority === 'high') {
            // Insert at beginning of queue
            this.queue.unshift({ text: textUtils.formatTextForTTS(text), options: { priority } });
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
