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
 * @version 1.0.0
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

        // Supported modes in order of preference
        this.defaultMode = 'webrtc,mse,hls,mjpeg';
    }

    /**
     * Set the Home Assistant instance
     * @param {Object} hass 
     */
    setHass(hass) {
        this._hass = hass;
        // Update hass reference for all existing streams
        this.streams.forEach(entry => {
            entry.hass = hass;
        });
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
        if (!entry.ws && !entry.pc && entry.status !== 'connecting') {
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
            // Keep connection alive for a grace period in case user navigates back
            setTimeout(() => {
                const currentEntry = this.streams.get(key);
                if (currentEntry && currentEntry.subscribers.size === 0) {
                    this._closeStream(key);
                }
            }, 30000); // 30 second grace period
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
        if (!entry.hass) {
            entry.status = 'error';
            this._notifySubscribers(entry, null, 'error', null);
            console.error('[StreamManager] No hass instance available');
            return;
        }

        entry.status = 'connecting';
        this._notifySubscribers(entry, null, 'connecting', null);

        try {
            // Get signed WebSocket URL from Home Assistant
            const data = await entry.hass.callWS({
                type: 'auth/sign_path', 
                path: '/api/webrtc/ws'
            });

            let wsURL = 'ws' + entry.hass.hassUrl(data.path).substring(4);

            if (entry.entity) {
                wsURL += '&entity=' + entry.entity;
            } else if (entry.url) {
                wsURL += '&url=' + encodeURIComponent(entry.url);
            }

            if (entry.config.server) {
                wsURL += '&server=' + encodeURIComponent(entry.config.server);
            }

            // Create WebSocket connection
            entry.ws = new WebSocket(wsURL);
            entry.ws.binaryType = 'arraybuffer';

            entry.ws.onopen = () => this._onWsOpen(entry);
            entry.ws.onmessage = (ev) => this._onWsMessage(entry, ev);
            entry.ws.onerror = (ev) => this._onWsError(entry, ev);
            entry.ws.onclose = () => this._onWsClose(entry);

        } catch (err) {
            console.error('[StreamManager] Connection error:', err);
            entry.status = 'error';
            this._notifySubscribers(entry, null, 'error', null);
            this._scheduleReconnect(entry);
        }
    }

    /**
     * Handle WebSocket open
     * @param {StreamEntry} entry 
     */
    _onWsOpen(entry) {
        console.log('[StreamManager] WebSocket connected for', entry.key);
        entry.reconnectAttempts = 0;

        // Request the stream based on configured modes
        const modes = entry.config.mode.split(',').map(m => m.trim());
        
        // Try WebRTC first if available
        if (modes.includes('webrtc') || modes.includes('webrtc/tcp')) {
            this._startWebRTC(entry);
        } else if (modes.includes('mse')) {
            this._requestMSE(entry);
        }
    }

    /**
     * Start WebRTC connection
     * @param {StreamEntry} entry 
     */
    _startWebRTC(entry) {
        entry.pc = new RTCPeerConnection({
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
            sdpSemantics: 'unified-plan',
        });

        entry.pc.ontrack = (ev) => {
            if (ev.streams && ev.streams[0]) {
                entry.stream = ev.streams[0];
                entry.video.srcObject = entry.stream;
                entry.status = 'connected';
                entry.mode = 'webrtc';
                this._notifySubscribers(entry, entry.stream, 'connected', 'webrtc');
            }
        };

        entry.pc.onicecandidate = (ev) => {
            if (ev.candidate && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                entry.ws.send(JSON.stringify({
                    type: 'webrtc/candidate',
                    value: ev.candidate.candidate,
                }));
            }
        };

        entry.pc.oniceconnectionstatechange = () => {
            if (entry.pc.iceConnectionState === 'failed' || 
                entry.pc.iceConnectionState === 'disconnected') {
                this._handleDisconnect(entry);
            }
        };

        // Add transceivers for receiving
        entry.pc.addTransceiver('video', {direction: 'recvonly'});
        if (entry.config.media.includes('audio')) {
            entry.pc.addTransceiver('audio', {direction: 'recvonly'});
        }

        // Create and send offer
        entry.pc.createOffer().then(offer => {
            entry.pc.setLocalDescription(offer);
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                entry.ws.send(JSON.stringify({
                    type: 'webrtc/offer',
                    value: offer.sdp,
                }));
            }
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
            const msg = JSON.parse(ev.data);
            this._handleJsonMessage(entry, msg);
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
                    entry.pc.setRemoteDescription({
                        type: 'answer',
                        sdp: msg.value,
                    });
                }
                break;

            case 'webrtc/candidate':
                if (entry.pc && msg.value) {
                    entry.pc.addIceCandidate({
                        candidate: msg.value,
                        sdpMid: '0',
                    });
                }
                break;

            case 'mse':
                entry.mode = 'mse';
                this._initMSE(entry, msg.value);
                break;

            case 'error':
                console.error('[StreamManager] Stream error:', msg.value);
                entry.status = 'error';
                this._notifySubscribers(entry, null, 'error', null);
                break;
        }
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
    _onWsError(entry, ev) {
        console.error('[StreamManager] WebSocket error for', entry.key, ev);
    }

    /**
     * Handle WebSocket close
     * @param {StreamEntry} entry 
     */
    _onWsClose(entry) {
        console.log('[StreamManager] WebSocket closed for', entry.key);
        this._handleDisconnect(entry);
    }

    /**
     * Handle disconnection and schedule reconnect
     * @param {StreamEntry} entry 
     */
    _handleDisconnect(entry) {
        entry.ws = null;
        
        if (entry.pc) {
            entry.pc.close();
            entry.pc = null;
        }

        entry.stream = null;
        entry.status = 'disconnected';
        this._notifySubscribers(entry, null, 'disconnected', null);

        // Only reconnect if there are still subscribers
        if (entry.subscribers.size > 0) {
            this._scheduleReconnect(entry);
        }
    }

    /**
     * Schedule reconnection attempt
     * @param {StreamEntry} entry 
     */
    _scheduleReconnect(entry) {
        if (entry.reconnectTimer) return;
        if (entry.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[StreamManager] Max reconnect attempts reached for', entry.key);
            entry.status = 'error';
            this._notifySubscribers(entry, null, 'error', null);
            return;
        }

        entry.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, entry.reconnectAttempts - 1);
        
        console.log(`[StreamManager] Reconnecting ${entry.key} in ${delay}ms (attempt ${entry.reconnectAttempts})`);
        
        entry.reconnectTimer = setTimeout(() => {
            entry.reconnectTimer = null;
            if (entry.subscribers.size > 0) {
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

        console.log('[StreamManager] Closing stream', key);

        if (entry.reconnectTimer) {
            clearTimeout(entry.reconnectTimer);
        }

        if (entry.ws) {
            entry.ws.close();
        }

        if (entry.pc) {
            entry.pc.close();
        }

        if (entry.video && entry.video.parentNode) {
            entry.video.parentNode.removeChild(entry.video);
        }

        if (entry._mediaSource) {
            URL.revokeObjectURL(entry.video.src);
        }

        this.streams.delete(key);
    }

    /**
     * Force reconnect a stream
     * @param {string} key 
     */
    reconnect(key) {
        const entry = this.streams.get(key);
        if (!entry) return;

        if (entry.ws) {
            entry.ws.close();
        }
        if (entry.pc) {
            entry.pc.close();
            entry.pc = null;
        }

        entry.reconnectAttempts = 0;
        this._connect(entry);
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
