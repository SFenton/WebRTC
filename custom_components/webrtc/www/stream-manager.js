/**
 * WebRTC Stream Manager
 * 
 * A singleton that manages persistent WebSocket connections to go2rtc streams.
 * This allows multiple cards to share the same stream connection, and connections
 * persist even when cards are removed from the DOM (page navigation).
 * 
 * Key features:
 * - Connection pooling by stream URL/entity
 * - Reference counting - connection stays alive while any subscriber exists
 * - Automatic reconnection on failure
 * - Stream sharing via MediaStream cloning
 * 
 * @version 1.3.0
 */

/**
 * @typedef {Object} StreamEntry
 * @property {string} key - Unique identifier (url or entity)
 * @property {string} url - The stream URL
 * @property {string|null} entity - The entity ID if applicable
 * @property {WebSocket|null} ws - The WebSocket connection
 * @property {RTCPeerConnection|null} pc - The WebRTC peer connection
 * @property {MediaStream|null} stream - The media stream
 * @property {HTMLVideoElement} video - Hidden video element for the stream
 * @property {Set<Function>} subscribers - Callbacks to notify on stream changes
 * @property {string} status - Current status: 'connecting', 'connected', 'error', 'closed'
 * @property {string} mode - Stream mode: 'webrtc', 'mse', 'hls', 'mjpeg'
 * @property {number} reconnectAttempts - Number of reconnection attempts
 * @property {number|null} reconnectTimer - Timer ID for reconnection
 * @property {Object|null} hass - Home Assistant instance reference
 * @property {Object} config - Stream configuration
 */

const FRAME_CHECK_MS = 1000;
const SIGN_TIMEOUT_MS = 10000;
const FIRST_FRAME_TIMEOUT_MS = 15000;
const FRAME_STALL_MS = 8000;
const ICE_RECOVERY_MS = 5000;
const HIDDEN_RELEASE_MS = 60000;
const UNSUBSCRIBED_GRACE_MS = 30000;

class WebRTCStreamManager {
    constructor() {
        /** @type {Map<string, StreamEntry>} */
        this.streams = new Map();
        
        /** @type {Object|null} */
        this._hass = null;
        
        /** @type {number} */
        this.maxReconnectAttempts = 5;
        
        /** @type {number} */
        this.reconnectDelay = 2000;
        this.maxReconnectDelay = 60000;
        this._haConnection = null;
        this._observingVisibility = false;
        this._handleHaReady = this._retryIdleStreams.bind(this);
        this._handleVisibilityChange = this._onVisibilityChange.bind(this);

        // Supported modes in order of preference
        this.defaultMode = 'webrtc,mse,hls,mjpeg';
    }

    /**
     * Set the Home Assistant instance
     * @param {Object} hass 
     */
    setHass(hass) {
        const connection = hass?.connection || null;
        if (connection !== this._haConnection) {
            this._haConnection?.removeEventListener?.('ready', this._handleHaReady);
            connection?.addEventListener?.('ready', this._handleHaReady);
            this._haConnection = connection;
        }
        const hadHass = !!this._hass;
        this._hass = hass;
        this.streams.forEach(entry => {
            entry.hass = hass;
        });
        if ((!hadHass && hass) || (connection && connection !== this._lastReadyConnection)) {
            this._lastReadyConnection = connection;
            this._retryIdleStreams();
        }
    }

    /**
     * Get or create a stream key from config
     * @param {Object} config - Stream config with url or entity
     * @returns {string}
     */
    getStreamKey(config) {
        // Use entity or URL as the unique key
        return config.entity || config.url;
    }

    /**
     * Subscribe to a stream. Creates connection if needed.
     * @param {Object} config - Stream configuration
     * @param {Function} callback - Called with (stream, status, mode) on changes
     * @returns {Function} Unsubscribe function
     */
    subscribe(config, callback) {
        const key = this.getStreamKey(config);
        if (!key) {
            console.error('[StreamManager] No url or entity in config');
            callback(null, 'error', null);
            return () => {};
        }

        let entry = this.streams.get(key);
        
        if (!entry) {
            // Create new stream entry
            entry = this._createStreamEntry(key, config);
            this.streams.set(key, entry);
        } else if (
            entry.config.media !== (config.media || 'video,audio') ||
            entry.config.mode !== (config.mode || this.defaultMode) ||
            entry.config.server !== config.server
        ) {
            console.error('[StreamManager] Incompatible shared stream configuration');
            callback(null, 'error', null);
            return () => {};
        }

        if (!this._observingVisibility) {
            document.addEventListener('visibilitychange', this._handleVisibilityChange);
            this._observingVisibility = true;
        }
        if (entry.idleTimer !== null) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
        // Add subscriber
        entry.subscribers.add(callback);

        // If stream is already available, notify immediately
        if (entry.stream) {
            callback(entry.stream, entry.status, entry.mode);
        } else if (entry.status === 'connecting') {
            callback(null, 'connecting', null);
        } else if (entry.status === 'error') {
            callback(null, 'error', null);
        }

        // Start connection if not already started
        if (!entry.ws && !entry.pc && !entry.reconnectTimer &&
            entry.status !== 'connecting' && entry.reconnectAttempts < this.maxReconnectAttempts) {
            this._connect(entry);
        }

        // Return unsubscribe function
        return () => this._unsubscribe(key, callback);
    }

    /**
     * Unsubscribe from a stream
     * @param {string} key 
     * @param {Function} callback 
     */
    _unsubscribe(key, callback) {
        const entry = this.streams.get(key);
        if (!entry) return;

        entry.subscribers.delete(callback);

        // If no more subscribers, schedule cleanup
        if (entry.subscribers.size === 0) {
            entry.idleTimer = setTimeout(() => {
                entry.idleTimer = null;
                const currentEntry = this.streams.get(key);
                if (currentEntry && currentEntry.subscribers.size === 0) {
                    this._closeStream(key);
                }
            }, UNSUBSCRIBED_GRACE_MS);
        }
    }

    /**
     * Create a new stream entry
     * @param {string} key 
     * @param {Object} config 
     * @returns {StreamEntry}
     */
    _createStreamEntry(key, config) {
        // Create a hidden video element for this stream
        const video = document.createElement('video');
        video.playsInline = true;
        video.muted = true; // Required for autoplay
        video.autoplay = true;
        video.style.display = 'none';
        document.body.appendChild(video);

        return {
            key,
            url: config.url,
            entity: config.entity,
            ws: null,
            pc: null,
            stream: null,
            video,
            subscribers: new Set(),
            status: 'idle',
            mode: null,
            reconnectAttempts: 0,
            reconnectTimer: null,
            signTimer: null,
            idleTimer: null,
            hiddenTimer: null,
            iceTimer: null,
            frameTimer: null,
            generation: 0,
            firstFrameAt: 0,
            lastFrameAt: 0,
            lastDecodedFrames: 0,
            remoteDescriptionSet: false,
            pendingCandidates: [],
            hass: this._hass,
            config: {
                mode: config.mode || this.defaultMode,
                media: config.media || 'video,audio',
                server: config.server,
            },
        };
    }

    /**
     * Connect to a stream
     * @param {StreamEntry} entry 
     */
    async _connect(entry) {
        if (this.streams.get(entry.key) !== entry || entry.ws || entry.pc ||
            entry.status === 'connecting' || document.visibilityState === 'hidden') return;
        if (!entry.hass) {
            entry.status = 'error';
            this._notifySubscribers(entry, null, 'error', null);
            console.error('[StreamManager] No hass instance available');
            return;
        }

        const generation = ++entry.generation;
        entry.status = 'connecting';
        this._notifySubscribers(entry, null, 'connecting', null);
        entry.signTimer = setTimeout(() => {
            if (!this._isCurrent(entry, generation) || entry.ws) return;
            console.error('[StreamManager] RTC signing request timed out');
            this._handleDisconnect(entry);
        }, SIGN_TIMEOUT_MS);

        try {
            // Get signed WebSocket URL from Home Assistant
            const data = await entry.hass.callWS({
                type: 'auth/sign_path', 
                path: '/api/webrtc/ws'
            });
            if (!this._isCurrent(entry, generation)) return;
            clearTimeout(entry.signTimer);
            entry.signTimer = null;
            if (document.visibilityState === 'hidden') {
                this._handleDisconnect(entry);
                return;
            }

            let wsURL = 'ws' + entry.hass.hassUrl(data.path).substring(4);

            if (entry.entity) {
                wsURL += '&entity=' + encodeURIComponent(entry.entity);
            } else if (entry.url) {
                wsURL += '&url=' + encodeURIComponent(entry.url);
            }

            if (entry.config.server) {
                wsURL += '&server=' + encodeURIComponent(entry.config.server);
            }

            // Create WebSocket connection
            const ws = new WebSocket(wsURL);
            entry.ws = ws;
            ws.binaryType = 'arraybuffer';
            ws.onopen = () => this._onWsOpen(entry, ws, generation);
            ws.onmessage = (ev) => {
                if (this._isCurrent(entry, generation) && entry.ws === ws) {
                    this._onWsMessage(entry, ev);
                }
            };
            ws.onerror = (ev) => this._onWsError(entry, ev, ws, generation);
            ws.onclose = () => this._onWsClose(entry, ws, generation);

        } catch (err) {
            if (!this._isCurrent(entry, generation)) return;
            console.error('[StreamManager] Connection error:', err);
            this._handleDisconnect(entry);
        }
    }

    _isCurrent(entry, generation) {
        return this.streams.get(entry.key) === entry && entry.generation === generation;
    }

    _isCurrentPeer(entry, pc, generation) {
        return this._isCurrent(entry, generation) && entry.pc === pc;
    }

    /**
     * Handle WebSocket open
     * @param {StreamEntry} entry 
     */
    _onWsOpen(entry, ws = entry.ws, generation = entry.generation) {
        if (!this._isCurrent(entry, generation) || entry.ws !== ws) return;

        // Request the stream based on configured modes
        const modes = entry.config.mode.split(',').map(m => m.trim());
        
        // Try WebRTC first if available
        try {
            if (modes.includes('webrtc') || modes.includes('webrtc/tcp')) {
                this._startWebRTC(entry, ws, generation);
            } else if (modes.includes('mse')) {
                entry.reconnectAttempts = 0;
                this._requestMSE(entry);
            } else {
                throw new Error('No supported stream mode configured');
            }
        } catch (error) {
            console.error('[StreamManager] Unable to start stream:', error);
            this._handleDisconnect(entry);
        }
    }

    /**
     * Start WebRTC connection
     * @param {StreamEntry} entry 
     */
    _startWebRTC(entry, ws = entry.ws, generation = entry.generation) {
        const pc = new RTCPeerConnection({
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
            sdpSemantics: 'unified-plan',
        });
        entry.pc = pc;
        entry.mode = 'webrtc';
        entry.firstFrameAt = Date.now();
        entry.lastFrameAt = 0;
        entry.lastDecodedFrames = 0;
        entry.remoteDescriptionSet = false;
        entry.pendingCandidates = [];

        pc.ontrack = (ev) => {
            if (!this._isCurrentPeer(entry, pc, generation)) return;
            if (!entry._pendingStream) {
                entry._pendingStream = ev.streams?.[0] || new MediaStream();
            }
            if (ev.track && !entry._pendingStream.getTracks().includes(ev.track)) {
                entry._pendingStream.addTrack(ev.track);
            }
            if (entry.video.srcObject !== entry._pendingStream) {
                entry.video.srcObject = entry._pendingStream;
                Promise.resolve().then(() => entry.video.play()).catch(error => {
                    if (!this._isCurrentPeer(entry, pc, generation)) return;
                    console.error('[StreamManager] Muted RTC playback failed:', error);
                    this._handleDisconnect(entry);
                });
            }
        };

        pc.onconnectionstatechange = () => this._handlePeerState(entry, pc, generation);

        pc.onicecandidate = (ev) => {
            if (this._isCurrentPeer(entry, pc, generation) &&
                ev.candidate && entry.ws === ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'webrtc/candidate',
                    value: ev.candidate.candidate,
                }));
            }
        };

        pc.oniceconnectionstatechange = () => this._handlePeerState(entry, pc, generation);

        // Add transceivers for receiving
        pc.addTransceiver('video', {direction: 'recvonly'});
        if (entry.config.media.includes('audio')) {
            pc.addTransceiver('audio', {direction: 'recvonly'});
        }

        this._scheduleFrameCheck(entry, pc, generation);
        Promise.resolve().then(async () => {
            const offer = await pc.createOffer();
            if (!this._isCurrentPeer(entry, pc, generation)) return;
            await pc.setLocalDescription(offer);
            if (!this._isCurrentPeer(entry, pc, generation) || entry.ws !== ws ||
                ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({
                type: 'webrtc/offer',
                value: offer.sdp,
            }));
        }).catch(error => {
            if (!this._isCurrentPeer(entry, pc, generation)) return;
            console.error('[StreamManager] RTC offer failed:', error);
            this._handleDisconnect(entry);
        });
    }

    _handlePeerState(entry, pc, generation) {
        if (!this._isCurrentPeer(entry, pc, generation)) return;
        const states = [pc.connectionState, pc.iceConnectionState];
        if (states.includes('failed') || states.includes('closed')) {
            this._handleDisconnect(entry);
        } else if (states.includes('disconnected')) {
            if (document.visibilityState === 'hidden') return;
            if (entry.iceTimer !== null) return;
            entry.iceTimer = setTimeout(() => {
                entry.iceTimer = null;
                if (!this._isCurrentPeer(entry, pc, generation)) return;
                if (entry.lastFrameAt && Date.now() - entry.lastFrameAt < FRAME_STALL_MS) return;
                this._handleDisconnect(entry);
            }, ICE_RECOVERY_MS);
        } else if (entry.iceTimer !== null) {
            clearTimeout(entry.iceTimer);
            entry.iceTimer = null;
        }
    }

    _scheduleFrameCheck(entry, pc, generation) {
        if (entry.frameTimer !== null || document.visibilityState === 'hidden' ||
            !this._isCurrentPeer(entry, pc, generation)) return;
        entry.frameTimer = setTimeout(() => {
            entry.frameTimer = null;
            this._checkFrames(entry, pc, generation);
        }, FRAME_CHECK_MS);
    }

    async _checkFrames(entry, pc, generation) {
        if (!this._isCurrentPeer(entry, pc, generation)) return;
        let decodedFrames = null;
        try {
            if (typeof pc.getStats === 'function') {
                const stats = await pc.getStats();
                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' &&
                        (report.kind === 'video' || report.mediaType === 'video') &&
                        Number.isFinite(report.framesDecoded)) {
                        decodedFrames = (decodedFrames || 0) + report.framesDecoded;
                    }
                });
            }
            if (decodedFrames === null && typeof entry.video.getVideoPlaybackQuality === 'function') {
                const quality = entry.video.getVideoPlaybackQuality();
                if (Number.isFinite(quality.totalVideoFrames)) {
                    decodedFrames = quality.totalVideoFrames;
                }
            }
        } catch (error) {
            if (this._isCurrentPeer(entry, pc, generation) && !entry.statsErrorLogged) {
                console.error('[StreamManager] Unable to measure RTC frames:', error);
                entry.statsErrorLogged = true;
            }
        }
        if (!this._isCurrentPeer(entry, pc, generation) || document.visibilityState === 'hidden') return;

        if (decodedFrames !== null && decodedFrames > entry.lastDecodedFrames) {
            entry.lastDecodedFrames = decodedFrames;
            entry.lastFrameAt = Date.now();
            if (entry._pendingStream && entry.status !== 'connected') {
                entry.stream = entry._pendingStream;
                entry.status = 'connected';
                entry.reconnectAttempts = 0;
                this._notifySubscribers(entry, entry.stream, 'connected', 'webrtc');
            }
        }

        const now = Date.now();
        const firstFrameTimedOut = (!entry._pendingStream || !entry.lastFrameAt) &&
            now - entry.firstFrameAt >= FIRST_FRAME_TIMEOUT_MS;
        const videoStalled = entry.lastFrameAt > 0 && now - entry.lastFrameAt >= FRAME_STALL_MS;
        if (firstFrameTimedOut || videoStalled) {
            console.error('[StreamManager] RTC video frames stopped advancing');
            this._handleDisconnect(entry);
            return;
        }
        this._scheduleFrameCheck(entry, pc, generation);
    }

    _onVisibilityChange() {
        const hidden = document.visibilityState === 'hidden';
        this.streams.forEach(entry => {
            if (hidden) {
                if (entry.status === 'connecting' && !entry.pc) {
                    this._handleDisconnect(entry);
                }
                if (entry.frameTimer !== null) {
                    clearTimeout(entry.frameTimer);
                    entry.frameTimer = null;
                }
                if (entry.iceTimer !== null) {
                    clearTimeout(entry.iceTimer);
                    entry.iceTimer = null;
                }
                if (entry.reconnectTimer !== null) {
                    clearTimeout(entry.reconnectTimer);
                    entry.reconnectTimer = null;
                }
                if (entry.pc && entry.hiddenTimer === null) {
                    entry.hiddenTimer = setTimeout(() => {
                        entry.hiddenTimer = null;
                        if (document.visibilityState === 'hidden' && entry.pc) {
                            this._handleDisconnect(entry);
                        }
                    }, HIDDEN_RELEASE_MS);
                }
            } else {
                if (entry.hiddenTimer !== null) {
                    clearTimeout(entry.hiddenTimer);
                    entry.hiddenTimer = null;
                }
                if (entry.pc) {
                    entry.firstFrameAt = Date.now();
                    entry.lastFrameAt = Date.now();
                    if (entry.status === 'connected') {
                        entry.status = 'connecting';
                        this._notifySubscribers(entry, null, 'connecting', null);
                    }
                    this._scheduleFrameCheck(entry, entry.pc, entry.generation);
                } else if (entry.subscribers.size > 0 && !entry.ws && entry.status !== 'connecting') {
                    entry.reconnectAttempts = 0;
                    this._connect(entry);
                }
            }
        });
    }

    _retryIdleStreams() {
        if (document.visibilityState === 'hidden') return;
        this.streams.forEach(entry => {
            if (entry.subscribers.size === 0 || entry.pc || entry.ws) return;
            if (entry.status === 'connecting') {
                this._clearTransport(entry);
                entry.status = 'disconnected';
            }
            if (entry.reconnectTimer !== null) {
                clearTimeout(entry.reconnectTimer);
                entry.reconnectTimer = null;
            }
            entry.reconnectAttempts = 0;
            this._connect(entry);
        });
    }

    /**
     * Request MSE stream
     * @param {StreamEntry} entry 
     */
    _requestMSE(entry) {
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify({type: 'mse'}));
        }
    }

    /**
     * Handle WebSocket message
     * @param {StreamEntry} entry 
     * @param {MessageEvent} ev 
     */
    _onWsMessage(entry, ev) {
        if (typeof ev.data === 'string') {
            try {
                this._handleJsonMessage(entry, JSON.parse(ev.data));
            } catch (error) {
                console.error('[StreamManager] Invalid RTC signaling message:', error);
                this._handleDisconnect(entry);
            }
        } else {
            // Binary data for MSE
            this._handleBinaryData(entry, ev.data);
        }
    }

    /**
     * Handle JSON message from WebSocket
     * @param {StreamEntry} entry 
     * @param {Object} msg 
     */
    _handleJsonMessage(entry, msg) {
        switch (msg.type) {
            case 'webrtc/answer':
                if (entry.pc) {
                    const pc = entry.pc;
                    const generation = entry.generation;
                    Promise.resolve(pc.setRemoteDescription({
                        type: 'answer',
                        sdp: msg.value,
                    })).then(() => {
                        if (!this._isCurrentPeer(entry, pc, generation)) return;
                        entry.remoteDescriptionSet = true;
                        for (const candidate of entry.pendingCandidates.splice(0)) {
                            this._addIceCandidate(entry, pc, generation, candidate);
                        }
                    }).catch(error => {
                        if (!this._isCurrentPeer(entry, pc, generation)) return;
                        console.error('[StreamManager] RTC answer failed:', error);
                        this._handleDisconnect(entry);
                    });
                }
                break;

            case 'webrtc/candidate':
                if (entry.pc && msg.value) {
                    if (entry.remoteDescriptionSet) {
                        this._addIceCandidate(entry, entry.pc, entry.generation, msg.value);
                    } else {
                        entry.pendingCandidates.push(msg.value);
                    }
                }
                break;

            case 'mse':
                entry.mode = 'mse';
                this._initMSE(entry, msg.value);
                break;

            case 'error':
                console.error('[StreamManager] Stream error:', msg.value);
                this._handleDisconnect(entry);
                break;
        }
    }

    _addIceCandidate(entry, pc, generation, value) {
        Promise.resolve().then(() => pc.addIceCandidate({
            candidate: value,
            sdpMid: '0',
        })).catch(error => {
            if (!this._isCurrentPeer(entry, pc, generation)) return;
            console.error('[StreamManager] RTC candidate failed:', error);
            this._handleDisconnect(entry);
        });
    }

    /**
     * Initialize MSE playback
     * @param {StreamEntry} entry 
     * @param {string} codec 
     */
    _initMSE(entry, codec) {
        if (!MediaSource.isTypeSupported(codec)) {
            console.error('[StreamManager] Codec not supported:', codec);
            return;
        }

        const ms = new MediaSource();
        entry.video.src = URL.createObjectURL(ms);
        entry._mediaSource = ms;

        ms.addEventListener('sourceopen', () => {
            entry._sourceBuffer = ms.addSourceBuffer(codec);
            entry._sourceBuffer.mode = 'segments';
            entry._pendingBuffers = [];

            entry._sourceBuffer.addEventListener('updateend', () => {
                if (entry._pendingBuffers.length > 0) {
                    entry._sourceBuffer.appendBuffer(entry._pendingBuffers.shift());
                }
            });

            entry.status = 'connected';
            entry.stream = entry.video.captureStream ? entry.video.captureStream() : null;
            this._notifySubscribers(entry, entry.stream, 'connected', 'mse');
        });
    }

    /**
     * Handle binary MSE data
     * @param {StreamEntry} entry 
     * @param {ArrayBuffer} data 
     */
    _handleBinaryData(entry, data) {
        if (!entry._sourceBuffer) return;

        if (entry._sourceBuffer.updating || entry._pendingBuffers.length > 0) {
            entry._pendingBuffers.push(data);
        } else {
            try {
                entry._sourceBuffer.appendBuffer(data);
            } catch (e) {
                console.error('[StreamManager] MSE append error:', e);
            }
        }
    }

    /**
     * Handle WebSocket error
     * @param {StreamEntry} entry 
     * @param {Event} ev 
     */
    _onWsError(entry, ev, ws = entry.ws, generation = entry.generation) {
        if (!this._isCurrent(entry, generation) || entry.ws !== ws) return;
        console.error('[StreamManager] WebSocket error for', entry.key, ev);
        this._handleDisconnect(entry);
    }

    /**
     * Handle WebSocket close
     * @param {StreamEntry} entry 
     */
    _onWsClose(entry, ws = entry.ws, generation = entry.generation) {
        if (!this._isCurrent(entry, generation) || entry.ws !== ws) return;
        entry.ws = null;
        if (entry.pc && entry.mode === 'webrtc' &&
            !['failed', 'closed'].includes(entry.pc.connectionState)) {
            return;
        }
        this._handleDisconnect(entry);
    }

    /**
     * Handle disconnection and schedule reconnect
     * @param {StreamEntry} entry 
     */
    _handleDisconnect(entry) {
        if (this.streams.get(entry.key) !== entry) return;
        this._clearTransport(entry);
        entry.status = 'disconnected';
        this._notifySubscribers(entry, null, 'disconnected', null);

        if (entry.subscribers.size > 0 && document.visibilityState !== 'hidden') {
            this._scheduleReconnect(entry);
        }
    }

    _clearTransport(entry) {
        entry.generation++;
        for (const timer of ['signTimer', 'frameTimer', 'iceTimer', 'hiddenTimer']) {
            if (entry[timer] !== null) clearTimeout(entry[timer]);
            entry[timer] = null;
        }
        const ws = entry.ws;
        entry.ws = null;
        if (ws) {
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            ws.close();
        }
        const pc = entry.pc;
        entry.pc = null;
        if (pc) {
            pc.ontrack = pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.onicecandidate = null;
            pc.close();
        }
        if (entry._mediaSource && entry.video.src) URL.revokeObjectURL(entry.video.src);
        entry._mediaSource = null;
        entry._sourceBuffer = null;
        entry.video.srcObject = null;
        entry.video.removeAttribute('src');
        entry._pendingStream = null;
        entry.stream = null;
        entry.mode = null;
        entry.remoteDescriptionSet = false;
        entry.pendingCandidates = [];
        entry.firstFrameAt = 0;
        entry.lastFrameAt = 0;
        entry.lastDecodedFrames = 0;
        entry.statsErrorLogged = false;
    }

    /**
     * Schedule reconnection attempt
     * @param {StreamEntry} entry 
     */
    _scheduleReconnect(entry) {
        if (entry.reconnectTimer !== null) return;
        if (entry.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[StreamManager] Max reconnect attempts reached for', entry.key);
            entry.status = 'error';
            this._notifySubscribers(entry, null, 'error', null);
            return;
        }

        entry.reconnectAttempts++;
        const delay = Math.min(this.maxReconnectDelay,
            this.reconnectDelay * Math.pow(2, entry.reconnectAttempts - 1));
        
        console.log(`[StreamManager] Reconnecting ${entry.key} in ${delay}ms (attempt ${entry.reconnectAttempts})`);
        
        entry.reconnectTimer = setTimeout(() => {
            entry.reconnectTimer = null;
            if (entry.subscribers.size > 0 && document.visibilityState !== 'hidden') {
                this._connect(entry);
            }
        }, delay);
    }

    /**
     * Notify all subscribers of a stream change
     * @param {StreamEntry} entry 
     * @param {MediaStream|null} stream 
     * @param {string} status 
     * @param {string|null} mode 
     */
    _notifySubscribers(entry, stream, status, mode) {
        entry.subscribers.forEach(callback => {
            try {
                callback(stream, status, mode);
            } catch (e) {
                console.error('[StreamManager] Subscriber callback error:', e);
            }
        });
    }

    /**
     * Close a stream and clean up resources
     * @param {string} key 
     */
    _closeStream(key) {
        const entry = this.streams.get(key);
        if (!entry) return;

        if (entry.reconnectTimer !== null) clearTimeout(entry.reconnectTimer);
        if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
        this._clearTransport(entry);

        if (entry.video && entry.video.parentNode) {
            entry.video.parentNode.removeChild(entry.video);
        }

        this.streams.delete(key);
        if (this.streams.size === 0 && this._observingVisibility) {
            document.removeEventListener('visibilitychange', this._handleVisibilityChange);
            this._observingVisibility = false;
        }
    }

    /**
     * Force reconnect a stream
     * @param {string} key 
     */
    reconnect(key) {
        const entry = this.streams.get(key);
        if (!entry) return;

        if (entry.reconnectTimer !== null) clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
        this._clearTransport(entry);
        entry.status = 'disconnected';
        this._notifySubscribers(entry, null, 'disconnected', null);
        entry.reconnectAttempts = 0;
        if (entry.subscribers.size > 0) this._connect(entry);
    }

    /**
     * Get current status of a stream
     * @param {string} key 
     * @returns {{status: string, mode: string|null, subscriberCount: number}|null}
     */
    getStreamStatus(key) {
        const entry = this.streams.get(key);
        if (!entry) return null;

        return {
            status: entry.status,
            mode: entry.mode,
            subscriberCount: entry.subscribers.size,
        };
    }

    /**
     * Get list of all active streams
     * @returns {Array<{key: string, status: string, mode: string|null, subscriberCount: number}>}
     */
    getActiveStreams() {
        const result = [];
        this.streams.forEach((entry, key) => {
            result.push({
                key,
                status: entry.status,
                mode: entry.mode,
                subscriberCount: entry.subscribers.size,
            });
        });
        return result;
    }
}

// Create singleton instance
const streamManager = new WebRTCStreamManager();

// Export for use in other modules
export { WebRTCStreamManager, streamManager };

// Also attach to window for debugging and cross-module access
if (typeof window !== 'undefined') {
    window.__webrtcStreamManager = streamManager;
}
