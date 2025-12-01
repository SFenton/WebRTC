/** Chrome 63+, Safari 11.1+ */
import {VideoRTC} from './video-rtc.js?v=1.9.12';
import {DigitalPTZ} from './digital-ptz.js?v=3.3.0';
import {streamManager} from './stream-manager.js?v=1.0.0';

/**
 * Global stream registry for sharing streams between cards.
 * Allows multiple cards to display the same stream without multiple connections.
 * @type {Map<string, {stream: MediaStream|null, video: HTMLVideoElement, subscribers: Set<WebRTCCamera>, owner: WebRTCCamera}>}
 */
if (typeof window !== 'undefined' && !window.__webrtcStreams) {
    window.__webrtcStreams = new Map();
}

class WebRTCCamera extends VideoRTC {
    constructor() {
        super();
        this._globalActionBindings = null;
        this._isClone = false;
        this._sourceCardId = null;
    }
    /**
     * Step 1. Called by the Hass, when config changed.
     * @param {Object} config
     */
    setConfig(config) {
        // Allow clone cards that only have a source reference
        if (!config.source && !config.url && !config.entity && !config.streams) {
            throw new Error('Missing `url` or `entity` or `streams` or `source`');
        }

        if (config.background) this.background = config.background;

        if (config.intersection === 0) this.visibilityThreshold = 0;
        else this.visibilityThreshold = config.intersection || 0.75;

        /**
         * @type {{
         *     url: string,
         *     entity: string,
         *     mode: string,
         *     media: string,
         *
         *     source: string,
         *
         *     streams: Array<{
         *         name: string,
         *         url: string,
         *         entity: string,
         *         mode: string,
         *         media: string,
         *     }>,
         *
         *     title: string,
         *     poster: string,
         *     poster_remote: boolean,
         *     muted: boolean,
         *     intersection: number,
         *     ui: boolean,
         *     controls: boolean,
         *     style: string,
         *     background: boolean,
         *
         *     server: string,
         *
         *     mse: boolean,
         *     webrtc: boolean,
         *
         *     digital_ptz:{
         *         mouse_drag_pan: boolean,
         *         mouse_wheel_zoom: boolean,
         *         mouse_double_click_zoom: boolean,
         *         touch_pinch_zoom: boolean,
         *         touch_drag_pan: boolean,
         *         touch_tap_drag_zoom: boolean,
         *         persist: boolean|string,
         *     },
         *     ptz:{
         *         opacity: number|string,
         *         service: string,
         *         data_left, data_up, data_right, data_down, data_zoom_in, data_zoom_out, data_home
         *     },
         *     shortcuts:Array<{ name:string, icon:string }>,
         *
         *     tap_action: {action: string, entity?: string, service?: string, data?: object, navigation_path?: string, url_path?: string},
         *     double_tap_action: {action: string, entity?: string, service?: string, data?: object, navigation_path?: string, url_path?: string},
         *     hold_action: {action: string, entity?: string, service?: string, data?: object, navigation_path?: string, url_path?: string},
         *     
         *     shared: boolean,
         * }} config
         */
        
        // Check if this is a clone card (explicit source reference)
        this._isClone = !!config.source;
        this._sourceCardId = config.source || null;
        
        // Check if this card uses the shared stream manager
        this._useStreamManager = !!config.shared;
        
        this.config = Object.assign({
            mode: config.mse === false ? 'webrtc' : config.webrtc === false ? 'mse' : this.mode,
            media: this.media,
            streams: config.source ? [] : [{url: config.url, entity: config.entity}],
            poster_remote: config.poster && (config.poster.indexOf('://') > 0 || config.poster.charAt(0) === '/'),
        }, config);

        if (!this.config.id && this.config.card_id) {
            this.config.id = this.config.card_id;
        }

        this.streamID = -1;
        this.nextStream(false);

        this.onhass = [];
    }

    set hass(hass) {
        this._hass = hass;
        this.onhass.forEach(fn => fn());
        
        // Update stream manager with hass instance
        if (this._useStreamManager && streamManager) {
            streamManager.setHass(hass);
        }
        // if card in vertical stack - `hass` property assign after `onconnect`
        // this.onconnect();
    }

    get hass() {
        return this._hass;
    }

    /**
     * Called by the Hass to calculate default card height.
     */
    getCardSize() {
        return 5; // x 50px
    }

    /**
     * Called by the Hass to get defaul card config
     * @return {{url: string}}
     */
    static getStubConfig() {
        return {'url': ''};
    }

    setStatus(mode, status) {
        const divMode = this.querySelector('.mode').innerText;
        if (mode === 'error' && divMode !== 'Loading..' && divMode !== 'Loading...') return;

        this.querySelector('.mode').innerText = mode;
        this.querySelector('.status').innerText = status || '';
    }

    /** @param reload {boolean} */
    nextStream(reload) {
        // Clone cards don't have their own streams
        if (this._isClone || !this.config.streams || this.config.streams.length === 0) {
            return;
        }
        
        this.streamID = (this.streamID + 1) % this.config.streams.length;

        const stream = this.config.streams[this.streamID];
        this.config.url = stream.url;
        this.config.entity = stream.entity;
        this.mode = stream.mode || this.config.mode;
        this.media = stream.media || this.config.media;

        if (reload) {
            this.ondisconnect();
            setTimeout(() => this.onconnect(), 100); // wait ws.close event
        }
    }

    /** @return {string} */
    get streamName() {
        if (this._isClone) return 'Clone';
        if (!this.config.streams || this.config.streams.length === 0) return '';
        return this.config.streams[this.streamID].name || `S${this.streamID}`;
    }

    connectedCallback() {
        // For clone cards, handle subscription instead of normal connection
        if (this._isClone) {
            // Still need to initialize the video element if not done
            if (!this.video) {
                this.oninit();
            }
            this._updateStreamStatus('connecting');
            this._subscribeToSource();
            this._bindGlobalActionEvents();
            this._initializeActionHandlers();
            this._initializeAudioState();
            return;
        }
        
        // For shared stream manager mode
        if (this._useStreamManager) {
            if (!this.video) {
                this.oninit();
            }
            this._updateStreamStatus('connecting');
            this._subscribeToStreamManager();
            this._bindGlobalActionEvents();
            this._initializeActionHandlers();
            this._initializeAudioState();
            return;
        }
        
        super.connectedCallback();
        this._bindGlobalActionEvents();
        this._initializeActionHandlers();
        // Emit initial mute state (will set body class if muted)
        this._initializeAudioState();
        
        // Register as stream owner for sharing
        if (this.config?.id) {
            this._registerAsStreamOwner();
        }
    }

    disconnectedCallback() {
        this._unbindGlobalActionEvents();
        this._cleanupActionHandlers();
        this._cleanupBodyMuteClass();
        
        // For clone cards, unsubscribe from source
        if (this._isClone) {
            this._unsubscribeFromSource();
            return;
        }
        
        // For shared stream manager mode, unsubscribe
        if (this._useStreamManager) {
            this._unsubscribeFromStreamManager();
            return;
        }
        
        // For primary cards, unregister from registry
        if (this.config?.id) {
            this._unregisterAsStreamOwner();
        }
        
        super.disconnectedCallback();
    }
    
    _initializeAudioState() {
        // Defer to next tick to ensure video is initialized
        setTimeout(() => this.emitAudioState(), 0);
    }
    
    _cleanupBodyMuteClass() {
        const cardId = this.config ? this.config.id : undefined;
        if (cardId && typeof document !== 'undefined' && document.body) {
            document.body.classList.remove(`webrtc-muted-${cardId}`);
            document.body.classList.remove(`webrtc-unmuted-${cardId}`);
        }
    }

    // ========== Stream Sharing Methods ==========

    /**
     * Get the global stream registry.
     * @returns {Map<string, {stream: MediaStream|null, video: HTMLVideoElement, subscribers: Set<WebRTCCamera>, owner: WebRTCCamera}>}
     */
    static get streamRegistry() {
        if (typeof window === 'undefined') return new Map();
        if (!window.__webrtcStreams) window.__webrtcStreams = new Map();
        return window.__webrtcStreams;
    }

    /**
     * Register this card as a stream owner in the global registry.
     * Called when a primary card (non-clone) establishes a connection.
     */
    _registerAsStreamOwner() {
        const cardId = this.config?.id;
        if (!cardId) return;

        const registry = WebRTCCamera.streamRegistry;
        
        // Check if already registered
        if (registry.has(cardId)) {
            const existing = registry.get(cardId);
            // If we're the existing owner, just update
            if (existing.owner === this) {
                existing.video = this.video;
                existing.stream = this.video?.srcObject || null;
                return;
            }
            // Someone else owns it - don't overwrite
            return;
        }

        registry.set(cardId, {
            stream: this.video?.srcObject || null,
            video: this.video,
            subscribers: new Set(),
            owner: this,
        });
    }

    /**
     * Update the registered stream when video source changes.
     * Called when stream becomes available.
     */
    _updateRegisteredStream() {
        const cardId = this.config?.id;
        if (!cardId) return;

        const registry = WebRTCCamera.streamRegistry;
        const entry = registry.get(cardId);
        
        if (entry && entry.owner === this) {
            const newStream = this.video?.srcObject || null;
            entry.stream = newStream;
            entry.video = this.video;
            
            // Notify all subscribers that stream is available
            entry.subscribers.forEach(subscriber => {
                subscriber._onSourceStreamUpdated(newStream);
            });
        }
    }

    /**
     * Unregister this card from the stream registry.
     * Called when a primary card disconnects.
     */
    _unregisterAsStreamOwner() {
        const cardId = this.config?.id;
        if (!cardId) return;

        const registry = WebRTCCamera.streamRegistry;
        const entry = registry.get(cardId);
        
        if (entry && entry.owner === this) {
            // Notify subscribers that stream is going away
            entry.subscribers.forEach(subscriber => {
                subscriber._onSourceStreamUpdated(null);
            });
            registry.delete(cardId);
        }
    }

    /**
     * Subscribe to another card's stream (for clone cards).
     * @returns {boolean} True if successfully subscribed
     */
    _subscribeToSource() {
        if (!this._sourceCardId) return false;

        const registry = WebRTCCamera.streamRegistry;
        const entry = registry.get(this._sourceCardId);
        
        if (!entry) {
            // Source not available yet - we'll retry on connect
            return false;
        }

        entry.subscribers.add(this);
        
        // If stream is already available, use it
        if (entry.stream) {
            this._onSourceStreamUpdated(entry.stream);
        }
        
        return true;
    }

    /**
     * Unsubscribe from the source stream.
     */
    _unsubscribeFromSource() {
        if (!this._sourceCardId) return;

        const registry = WebRTCCamera.streamRegistry;
        const entry = registry.get(this._sourceCardId);
        
        if (entry) {
            entry.subscribers.delete(this);
        }
    }

    /**
     * Called when the source stream is updated (for clone cards).
     * @param {MediaStream|null} stream
     */
    _onSourceStreamUpdated(stream) {
        if (!this.video) return;
        
        if (stream) {
            this.video.srcObject = stream;
            this.setStatus('CLONE', this.config.title || '');
            this._updateStreamStatus('connected');
            this.play();
        } else {
            this.video.srcObject = null;
            this.setStatus('Waiting...', '');
            this._updateStreamStatus('connecting');
        }
    }

    /**
     * Check if this card is a clone of another.
     * @returns {boolean}
     */
    get isCloneCard() {
        return this._isClone;
    }

    // ========== Stream Manager Methods ==========

    /**
     * Subscribe to the global stream manager.
     * The stream manager maintains persistent connections across page navigation.
     */
    _subscribeToStreamManager() {
        if (!this.config) return;
        
        // Update the stream manager with current hass instance
        if (this._hass && streamManager) {
            streamManager.setHass(this._hass);
        }

        // Get current stream config
        const streamConfig = this.config.streams?.[this.streamID] || {
            url: this.config.url,
            entity: this.config.entity,
        };

        if (!streamConfig.url && !streamConfig.entity) {
            this.setStatus('error', 'No URL or entity');
            return;
        }

        // Build config for stream manager
        const managerConfig = {
            url: streamConfig.url,
            entity: streamConfig.entity,
            mode: streamConfig.mode || this.config.mode || 'webrtc,mse,hls,mjpeg',
            media: streamConfig.media || this.config.media || 'video,audio',
            server: this.config.server,
        };

        this.setStatus('Loading..', '');
        this._updateStreamStatus('connecting');

        // Subscribe to the stream manager
        this._streamManagerUnsubscribe = streamManager.subscribe(managerConfig, (stream, status, mode) => {
            this._onStreamManagerUpdate(stream, status, mode);
        });
    }

    /**
     * Unsubscribe from the stream manager.
     */
    _unsubscribeFromStreamManager() {
        if (this._streamManagerUnsubscribe) {
            this._streamManagerUnsubscribe();
            this._streamManagerUnsubscribe = null;
        }
    }

    /**
     * Handle stream updates from the stream manager.
     * @param {MediaStream|null} stream 
     * @param {string} status - 'connecting', 'connected', 'disconnected', 'error'
     * @param {string|null} mode - 'webrtc', 'mse', 'hls', 'mjpeg'
     */
    _onStreamManagerUpdate(stream, status, mode) {
        if (!this.video) return;

        // Update data attribute for CSS targeting (spinners, etc.)
        this._updateStreamStatus(status);

        switch (status) {
            case 'connecting':
                this.setStatus('Loading...', '');
                break;
                
            case 'connected':
                if (stream) {
                    this.video.srcObject = stream;
                    this.setStatus(mode?.toUpperCase() || 'SHARED', this.config.title || '');
                    this.play();
                    // Update registry for other cards that might clone this one
                    this._updateRegisteredStream();
                }
                break;
                
            case 'disconnected':
                this.setStatus('Reconnecting...', '');
                break;
                
            case 'error':
                this.setStatus('error', 'Stream failed');
                break;
        }
    }

    /**
     * Update the data-stream-status attribute for CSS targeting.
     * Allows external CSS (card_mod) to show spinners, overlays, etc. based on connection state.
     * Sets attribute on both the host element and the inner ha-card for styling flexibility.
     * @param {string} status - 'connecting', 'connected', 'disconnected', 'error'
     */
    _updateStreamStatus(status) {
        // Set on host element for external CSS (card_mod on parent containers)
        this.setAttribute('data-stream-status', status);
        
        // Also set on inner ha-card for shadow DOM styling
        const card = this.shadowRoot?.querySelector('ha-card');
        if (card) {
            card.setAttribute('data-stream-status', status);
        }
    }

    // ========== End Stream Sharing Methods ==========

    /**
     * Initialize action handlers for tap_action, double_tap_action, and hold_action.
     * Follows Bubble Card's pattern for dispatching hass-action events.
     */
    _initializeActionHandlers() {
        if (this._actionHandlersInitialized) return;
        
        // Only set up handlers if any action is configured
        const { tap_action, double_tap_action, hold_action } = this.config || {};
        if (!tap_action && !double_tap_action && !hold_action) return;

        // State for gesture detection
        this._actionState = {
            startX: 0,
            startY: 0,
            holdTimer: null,
            lastTapTime: 0,
            tapCount: 0,
            tapTimer: null,
            holdTriggered: false,
        };

        // Bind event handlers
        this._handlePointerDown = this._onPointerDown.bind(this);
        this._handlePointerUp = this._onPointerUp.bind(this);
        this._handlePointerCancel = this._onPointerCancel.bind(this);

        this.addEventListener('pointerdown', this._handlePointerDown);
        this.addEventListener('pointerup', this._handlePointerUp);
        this.addEventListener('pointercancel', this._handlePointerCancel);
        this.addEventListener('pointerleave', this._handlePointerCancel);

        // Prevent context menu on long press (for hold action)
        if (hold_action) {
            this._handleContextMenu = e => e.preventDefault();
            this.addEventListener('contextmenu', this._handleContextMenu);
        }

        this._actionHandlersInitialized = true;
    }

    _cleanupActionHandlers() {
        if (!this._actionHandlersInitialized) return;

        if (this._handlePointerDown) {
            this.removeEventListener('pointerdown', this._handlePointerDown);
        }
        if (this._handlePointerUp) {
            this.removeEventListener('pointerup', this._handlePointerUp);
        }
        if (this._handlePointerCancel) {
            this.removeEventListener('pointercancel', this._handlePointerCancel);
            this.removeEventListener('pointerleave', this._handlePointerCancel);
        }
        if (this._handleContextMenu) {
            this.removeEventListener('contextmenu', this._handleContextMenu);
        }

        if (this._actionState) {
            clearTimeout(this._actionState.holdTimer);
            clearTimeout(this._actionState.tapTimer);
        }

        this._actionState = null;
        this._actionHandlersInitialized = false;
    }

    _onPointerDown(event) {
        // Ignore right-clicks
        if (event.button !== 0) return;
        
        const state = this._actionState;
        if (!state) return;

        state.startX = event.clientX;
        state.startY = event.clientY;
        state.holdTriggered = false;

        // Set up hold timer
        const holdAction = this.config?.hold_action;
        if (holdAction && holdAction.action !== 'none') {
            state.holdTimer = setTimeout(() => {
                state.holdTriggered = true;
                this._executeAction('hold');
            }, 500); // 500ms for hold
        }
    }

    _onPointerUp(event) {
        const state = this._actionState;
        if (!state) return;

        // Clear hold timer
        clearTimeout(state.holdTimer);

        // If hold was triggered, don't also trigger tap
        if (state.holdTriggered) return;

        // Check if pointer moved significantly (cancel if dragged)
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;

        const now = Date.now();
        const doubleTapAction = this.config?.double_tap_action;
        const tapAction = this.config?.tap_action;

        // Double-tap detection
        if (doubleTapAction && doubleTapAction.action !== 'none') {
            if (now - state.lastTapTime < 300) {
                // Double tap detected
                clearTimeout(state.tapTimer);
                state.tapCount = 0;
                state.lastTapTime = 0;
                this._executeAction('double_tap');
                return;
            }
            
            // First tap - wait to see if there's a second
            state.lastTapTime = now;
            state.tapTimer = setTimeout(() => {
                state.lastTapTime = 0;
                if (tapAction && tapAction.action !== 'none') {
                    this._executeAction('tap');
                }
            }, 300);
        } else if (tapAction && tapAction.action !== 'none') {
            // No double-tap configured, execute tap immediately
            this._executeAction('tap');
        }
    }

    _onPointerCancel() {
        const state = this._actionState;
        if (!state) return;

        clearTimeout(state.holdTimer);
        state.holdTriggered = false;
    }

    /**
     * Execute an action by dispatching a hass-action event.
     * @param {'tap'|'double_tap'|'hold'} actionType
     */
    _executeAction(actionType) {
        const actionKey = `${actionType}_action`;
        const actionConfig = this.config?.[actionKey];
        if (!actionConfig || actionConfig.action === 'none') return;

        const action = actionConfig.action;

        // Handle navigate action directly (required for hash navigation to work with Bubble Card popups)
        if (action === 'navigate') {
            const path = actionConfig.navigation_path;
            if (path) {
                if (actionConfig.navigation_replace) {
                    history.replaceState(null, "", path);
                } else {
                    history.pushState(null, "", path);
                }
                // Dispatch location-changed event (required for Bubble Card popups)
                const event = new Event('location-changed', { bubbles: true, composed: true });
                event.detail = { replace: actionConfig.navigation_replace || false };
                window.dispatchEvent(event);
            }
            return;
        }

        // Handle URL action directly
        if (action === 'url') {
            const url = actionConfig.url_path;
            if (url) {
                window.open(url, '_blank');
            }
            return;
        }

        // For other actions (more-info, toggle, call-service, fire-dom-event), use hass-action
        // Build the config object for hass-action
        const hassActionConfig = {
            ...actionConfig,
            entity: actionConfig.entity || this.config.entity,
        };

        // Dispatch hass-action event (this is what HA's frontend listens for)
        const event = new Event('hass-action', { bubbles: true, composed: true });
        event.detail = {
            config: hassActionConfig,
            action: actionType,
        };
        this.dispatchEvent(event);
    }

    oninit() {
        super.oninit();
        
        // Allow disabling native video controls via config
        if (this.config.controls === false && this.video) {
            this.video.controls = false;
        }
        
        this.renderMain();
        this.renderDigitalPTZ();
        this.renderPTZ();
        this.renderCustomUI();
        this.renderShortcuts();
        this.renderStyle();

        this.addEventListener('webrtc-screenshot', ev => {
            this.handleScreenshotRequest(ev.detail || {});
        });
        this.addEventListener('webrtc-mute', ev => {
            this.handleMuteRequest(ev.detail || {}, true);
        });
        this.addEventListener('webrtc-unmute', ev => {
            this.handleMuteRequest(ev.detail || {}, false);
        });
        this.addEventListener('webrtc-toggle-mute', ev => {
            this.handleToggleMuteRequest(ev.detail || {});
        });
        this.addEventListener('webrtc-fullscreen', ev => {
            this.handleFullscreenRequest(ev.detail || {});
        });

        if (this.video) {
            this.video.addEventListener('volumechange', () => this.emitAudioState());
            this.emitAudioState();
        }
    }

    onconnect() {
        // Clone cards don't establish their own connection
        if (this._isClone) {
            // Try to subscribe to source if not already subscribed
            if (!this._subscribeToSource()) {
                this.setStatus('Waiting...', 'for source');
            }
            return false;
        }
        
        if (!this.config || !this.hass) return false;
        if (!this.isConnected || this.ws || this.pc) return false;

        const divMode = this.querySelector('.mode').innerText;
        if (divMode === 'Loading..') return;

        this.setStatus('Loading..');
        this._updateStreamStatus('connecting');

        this.hass.callWS({
            type: 'auth/sign_path', path: '/api/webrtc/ws'
        }).then(data => {
            if (this.config.poster && !this.config.poster_remote) {
                this.video.poster = this.hass.hassUrl(data.path) + '&poster=' + encodeURIComponent(this.config.poster);
            }

            this.wsURL = 'ws' + this.hass.hassUrl(data.path).substring(4);

            if (this.config.entity) {
                this.wsURL += '&entity=' + this.config.entity;
            } else if (this.config.url) {
                this.wsURL += '&url=' + encodeURIComponent(this.config.url);
            } else {
                this.setStatus('IMG');
                return;
            }

            if (this.config.server) {
                this.wsURL += '&server=' + encodeURIComponent(this.config.server);
            }

            if (super.onconnect()) {
                this.setStatus('Loading...');
            } else {
                this.setStatus('error', 'unable to connect');
                this._updateStreamStatus('error');
            }
        }).catch(er => {
            this.setStatus('error', er);
            this._updateStreamStatus('error');
        });
    }

    onopen() {
        const result = super.onopen();

        this.onmessage['stream'] = msg => {
            switch (msg.type) {
                case 'error':
                    this.setStatus('error', msg.value);
                    break;
                case 'mse':
                case 'hls':
                case 'mp4':
                case 'mjpeg':
                    this.setStatus(msg.type.toUpperCase(), this.config.title || '');
                    this._updateStreamStatus('connected');
                    // Update registry when stream type is known
                    this._updateRegisteredStream();
                    break;
            }
        };

        return result;
    }

    onpcvideo(ev) {
        super.onpcvideo(ev);

        if (this.pcState !== WebSocket.CLOSED) {
            this.setStatus('RTC', this.config.title || '');
            this._updateStreamStatus('connected');
            // Update registry for WebRTC streams
            this._updateRegisteredStream();
        }
    }

    renderMain() {
        const shadow = this.attachShadow({mode: 'open'});
        shadow.innerHTML = `
        <style>
            ha-card {
                width: 100%;
                height: 100%;
                margin: auto;
                overflow: hidden;
                position: relative;
            }
            ha-icon {
                color: white;
                cursor: pointer;
            }
            .player {
                background-color: black;
                height: 100%;
                position: relative; /* important for Safari */
            }
            .player:active {
                cursor: move; /* important for zoom-controller */
            }
            .player .ptz-transform {
                height: 100%;
            }
            .header {
                position: absolute;
                top: 6px;
                left: 10px;
                right: 10px;
                color: white;
                display: flex;
                justify-content: space-between;
                pointer-events: none;
            }
            .mode {
                cursor: pointer;
                opacity: 0.6;
                pointer-events: auto;
            }
            /* Loading spinner for stream status */
            @keyframes webrtc-spin {
                to { transform: rotate(360deg); }
            }
            .loading-spinner {
                display: none;
                position: absolute;
                top: 50%;
                left: 50%;
                width: 40px;
                height: 40px;
                margin: -20px 0 0 -20px;
                border: 4px solid rgba(255,255,255,0.3);
                border-top-color: white;
                border-radius: 50%;
                animation: webrtc-spin 1s linear infinite;
                z-index: 10;
                pointer-events: none;
            }
            ha-card[data-stream-status="connecting"] .loading-spinner,
            ha-card[data-stream-status="disconnected"] .loading-spinner {
                display: block;
            }
            /* Label overlay */
            .label {
                position: absolute;
                left: 16px;
                bottom: 16px;
                font-size: 13px;
                line-height: 1.2;
                font-weight: 600;
                color: white;
                pointer-events: none;
                z-index: 5;
            }
        </style>
        <ha-card class="card">
            <div class="player">
                <div class="ptz-transform"></div>
            </div>
            <div class="header">
                <div class="status"></div>
                <div class="mode"></div>
            </div>
            <div class="loading-spinner"></div>
            <div class="label"></div>
        </ha-card>
        `;

        this.querySelector = selectors => this.shadowRoot.querySelector(selectors);
        this.querySelector('.ptz-transform').appendChild(this.video);

        const mode = this.querySelector('.mode');
        mode.addEventListener('click', () => this.nextStream(true));

        if (this.config.muted) this.video.muted = true;
        if (this.config.poster_remote) this.video.poster = this.config.poster;
        
        // Set label if configured
        if (this.config.label) {
            this.querySelector('.label').textContent = this.config.label;
        }
    }

    renderDigitalPTZ() {
        if (this.config.digital_ptz === false) return;
        new DigitalPTZ(
            this.querySelector('.player'),
            this.querySelector('.player .ptz-transform'),
            this.video,
            Object.assign({}, this.config.digital_ptz, {persist_key: this.config.url})
        );
    }

    renderPTZ() {
        if (!this.config.ptz || !this.config.ptz.service) return;

        let hasMove = false;
        let hasZoom = false;
        let hasHome = false;
        for (const prefix of ['', '_start', '_end', '_long']) {
            hasMove = hasMove || this.config.ptz['data' + prefix + '_right'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_left'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_up'];
            hasMove = hasMove || this.config.ptz['data' + prefix + '_down'];

            hasZoom = hasZoom || this.config.ptz['data' + prefix + '_zoom_in'];
            hasZoom = hasZoom || this.config.ptz['data' + prefix + '_zoom_out'];

            hasHome = hasHome || this.config.ptz['data' + prefix + '_home'];
        }

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .ptz {
                    position: absolute;
                    top: 50%;
                    right: 10px;
                    transform: translateY(-50%);
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    transition: opacity .3s ease-in-out;
                    opacity: ${parseFloat(this.config.ptz.opacity) || 0.4};
                }
                .ptz:hover {
                    opacity: 1 !important;
                }
                .ptz-move {
                    position: relative;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 50%;
                    width: 80px;
                    height: 80px;
                    display: ${hasMove ? 'block' : 'none'};
                }
                .ptz-zoom {
                    position: relative;
                    width: 80px;
                    height: 40px;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 4px;
                    display: ${hasZoom ? 'block' : 'none'};
                }
                .ptz-home {
                    position: relative;
                    width: 40px;
                    height: 40px;
                    background-color: rgba(0, 0, 0, 0.3);
                    border-radius: 4px;
                    align-self: center;
                    display: ${hasHome ? 'block' : 'none'};
                }
                .up {
                    position: absolute;
                    top: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                }
                .down {
                    position: absolute;
                    bottom: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                }
                .left {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .right {
                    position: absolute;
                    right: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .zoom_out {
                    position: absolute;
                    left: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .zoom_in {
                    position: absolute;
                    right: 5px;
                    top: 50%;
                    transform: translateY(-50%);
                }
                .home {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', `
            <div class="ptz">
                <div class="ptz-move">
                    <ha-icon class="right" icon="mdi:arrow-right"></ha-icon>
                    <ha-icon class="left" icon="mdi:arrow-left"></ha-icon>
                    <ha-icon class="up" icon="mdi:arrow-up"></ha-icon>
                    <ha-icon class="down" icon="mdi:arrow-down"></ha-icon>
                </div>
                <div class="ptz-zoom">
                    <ha-icon class="zoom_in" icon="mdi:plus"></ha-icon>
                    <ha-icon class="zoom_out" icon="mdi:minus"></ha-icon>
                </div>
                <div class="ptz-home">
                    <ha-icon class="home" icon="mdi:home"></ha-icon>
                </div>
            </div>
        `);

        const template = JSON.stringify(this.config.ptz);
        const handle = path => {
            if (!this.config.ptz['data_' + path]) return;
            const config = template.indexOf('${') < 0 ? this.config.ptz : JSON.parse(eval('`' + template + '`'));
            const [domain, service] = config.service.split('.', 2);
            const data = config['data_' + path];
            this.hass.callService(domain, service, data);
        };
        const ptz = this.querySelector('.ptz');
        for (const [start, end] of [['touchstart', 'touchend'], ['mousedown', 'mouseup']]) {
            ptz.addEventListener(start, startEvt => {
                const {className} = startEvt.target;
                startEvt.preventDefault();
                handle('start_' + className);
                window.addEventListener(end, endEvt => {
                    endEvt.preventDefault();
                    handle('end_' + className);
                    if (endEvt.timeStamp - startEvt.timeStamp > 400) {
                        handle('long_' + className);
                    } else {
                        handle(className);
                    }
                }, {once: true});
            });
        }
    }

    saveScreenshot() {
        const a = document.createElement('a');

        if (this.video.videoWidth && this.video.videoHeight) {
            const canvas = document.createElement('canvas');
            canvas.width = this.video.videoWidth;
            canvas.height = this.video.videoHeight;
            canvas.getContext('2d').drawImage(this.video, 0, 0, canvas.width, canvas.height);
            a.href = canvas.toDataURL('image/jpeg');
        } else if (this.video.poster && this.video.poster.startsWith('data:image/jpeg')) {
            a.href = this.video.poster;
        } else {
            return;
        }

        const ts = new Date().toISOString().substring(0, 19).replaceAll('-', '').replaceAll(':', '');
        a.download = `snapshot_${ts}.jpeg`;
        a.click();
    }

    handleScreenshotRequest(detail = {}) {
        if (!this.matchesActionTarget(detail)) return;
        this.saveScreenshot();
    }

    handleMuteRequest(detail = {}, mute) {
        if (!this.matchesActionTarget(detail)) return;
        if (!this.video) return;
        this.video.muted = mute;
        this.emitAudioState();
    }

    handleToggleMuteRequest(detail = {}) {
        if (!this.matchesActionTarget(detail)) return;
        if (!this.video) return;
        this.video.muted = !this.video.muted;
        this.emitAudioState();
    }

    handleFullscreenRequest(detail = {}) {
        if (!this.matchesActionTarget(detail)) return;
        const request = this.requestFullscreen
            ? () => this.requestFullscreen()
            : this.video && this.video.requestFullscreen
                ? () => this.video.requestFullscreen()
                : null;
        if (!request) return;
        const result = request();
        if (result && result.catch) result.catch(console.warn);
    }

    matchesActionTarget(detail = {}) {
        const targetEntity = detail.target_entity;
        const targetUrl = detail.target_url;
        const targetId = detail.target_id;
        const hasFilter = !!(targetEntity || targetUrl || targetId);

        if (!hasFilter) return false;
        if (!this.config) return false;
        if (targetEntity && targetEntity !== this.config.entity) return false;
        if (targetUrl && targetUrl !== this.config.url) return false;
        if (targetId && targetId !== this.config.id) return false;

        return true;
    }

    emitAudioState() {
        if (!this.video) return;
        const muted = !!this.video.muted;
        this.dataset.muted = muted ? 'true' : 'false';
        
        // Update body class for CSS targeting from sibling elements
        const cardId = this.config ? this.config.id : undefined;
        if (cardId && typeof document !== 'undefined' && document.body) {
            const className = `webrtc-muted-${cardId}`;
            if (muted) {
                document.body.classList.add(className);
                document.body.classList.remove(`webrtc-unmuted-${cardId}`);
            } else {
                document.body.classList.remove(className);
                document.body.classList.add(`webrtc-unmuted-${cardId}`);
            }
        }
        
        const detail = {
            target_entity: this.config ? this.config.entity : undefined,
            target_url: this.config ? this.config.url : undefined,
            target_id: this.config ? this.config.id : undefined,
            muted,
        };
        this.dispatchEvent(new CustomEvent('webrtc-audio-state', {
            bubbles: true,
            composed: true,
            detail,
        }));
    }

    _bindGlobalActionEvents() {
        if (this._globalActionBindings || typeof window === 'undefined') return;

        // Map of webrtc event names to handlers
        const eventHandlers = {
            'webrtc-screenshot': detail => this.handleScreenshotRequest(detail),
            'webrtc-mute': detail => this.handleMuteRequest(detail, true),
            'webrtc-unmute': detail => this.handleMuteRequest(detail, false),
            'webrtc-toggle-mute': detail => this.handleToggleMuteRequest(detail),
            'webrtc-fullscreen': detail => this.handleFullscreenRequest(detail),
        };

        // Listen for raw CustomEvents (e.g. from Browser Mod or manual dispatch)
        const rawBindings = Object.entries(eventHandlers).map(([type, handler]) => {
            const fn = event => {
                const path = event.composedPath ? event.composedPath() : [];
                if (path.includes(this)) return;
                handler(event.detail || {});
            };
            window.addEventListener(type, fn);
            return {type, fn};
        });

        // Listen for hass-action events (from Bubble Card's fire-dom-event)
        const hassActionHandler = event => {
            const config = event.detail?.config;
            if (!config) return;

            // Check for fire-dom-event action type
            const action = config.tap_action || config;
            if (action.action !== 'fire-dom-event') return;

            const eventName = action.event;
            const handler = eventHandlers[eventName];
            if (!handler) return;

            // Build detail from the action config
            const detail = {
                target_id: action.target_id,
                target_entity: action.target_entity,
                target_url: action.target_url,
                ...(action.data || {}),
            };

            handler(detail);
        };
        window.addEventListener('hass-action', hassActionHandler);

        this._globalActionBindings = {
            raw: rawBindings,
            hassAction: hassActionHandler,
        };
    }

    _unbindGlobalActionEvents() {
        if (!this._globalActionBindings || typeof window === 'undefined') return;
        this._globalActionBindings.raw.forEach(({type, fn}) => window.removeEventListener(type, fn));
        window.removeEventListener('hass-action', this._globalActionBindings.hassAction);
        this._globalActionBindings = null;
    }

    renderCustomUI() {
        if (!this.config.ui) return;

        this.video.controls = false;
        this.video.style.pointerEvents = 'none';

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .spinner {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }
                .controls {
                    position: absolute;
                    left: 5px;
                    right: 5px;
                    bottom: 5px;
                    display: flex;
                    align-items: center;
                }
                .space {
                    width: 100%;
                }
                .volume {
                    display: none;
                }
                .stream {
                    padding-top: 2px;
                    margin-left: 2px;
                    font-weight: 400;
                    font-size: 20px;
                    color: white;
                    display: none;
                    cursor: pointer;
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', `
            <div class="ui">
                <ha-circular-progress class="spinner"></ha-circular-progress>
                <div class="controls">
                    <ha-icon class="fullscreen" icon="mdi:fullscreen"></ha-icon>
                    <ha-icon class="screenshot" icon="mdi:floppy"></ha-icon>
                    <ha-icon class="pictureinpicture" icon="mdi:picture-in-picture-bottom-right"></ha-icon>
                    <span class="stream">${this.streamName}</span>
                    <span class="space"></span>
                    <ha-icon class="play" icon="mdi:play"></ha-icon>
                    <ha-icon class="volume" icon="mdi:volume-high"></ha-icon>
                </div>
            </div>
        `);

        const video = this.video;

        const fullscreen = this.querySelector('.fullscreen');
        if (this.requestFullscreen) {
            this.addEventListener('fullscreenchange', () => {
                fullscreen.icon = document.fullscreenElement ? 'mdi:fullscreen-exit' : 'mdi:fullscreen';
            });
        } else if (video.webkitEnterFullscreen) {
            this.requestFullscreen = () => new Promise((resolve, reject) => {
                try {
                    video.webkitEnterFullscreen();
                } catch (e) {
                    reject(e);
                }
            });
            video.addEventListener('webkitendfullscreen', () => {
                setTimeout(() => this.play(), 1000); // fix bug in iOS
            });
        } else {
            fullscreen.style.display = 'none';
        }

        const pip = this.querySelector('.pictureinpicture');
        if (video.requestPictureInPicture) {
            video.addEventListener('enterpictureinpicture', () => {
                pip.icon = 'mdi:rectangle';
                this.background = true;
            });
            video.addEventListener('leavepictureinpicture', () => {
                pip.icon = 'mdi:picture-in-picture-bottom-right';
                this.background = this.config.background;
                this.play();
            });
        } else {
            pip.style.display = 'none';
        }

        const ui = this.querySelector('.ui');
        ui.addEventListener('click', ev => {
            const icon = ev.target.icon;
            if (icon === 'mdi:play') {
                this.play();
            } else if (icon === 'mdi:volume-mute') {
                video.muted = false;
            } else if (icon === 'mdi:volume-high') {
                video.muted = true;
            } else if (icon === 'mdi:fullscreen') {
                this.requestFullscreen().catch(console.warn);
            } else if (icon === 'mdi:fullscreen-exit') {
                document.exitFullscreen().catch(console.warn);
            } else if (icon === 'mdi:floppy') {
                this.saveScreenshot();
            } else if (icon === 'mdi:picture-in-picture-bottom-right') {
                video.requestPictureInPicture().catch(console.warn);
            } else if (icon === 'mdi:rectangle') {
                document.exitPictureInPicture().catch(console.warn);
            } else if (ev.target.className === 'stream') {
                this.nextStream(true);
                ev.target.innerText = this.streamName;
            }
        });

        const spinner = this.querySelector('.spinner');
        video.addEventListener('waiting', () => {
            spinner.style.display = 'block';
        });
        video.addEventListener('playing', () => {
            spinner.style.display = 'none';
        });

        const play = this.querySelector('.play');
        video.addEventListener('play', () => {
            play.style.display = 'none';
        });
        video.addEventListener('pause', () => {
            play.style.display = 'block';
        });

        const volume = this.querySelector('.volume');
        video.addEventListener('loadeddata', () => {
            volume.style.display = this.hasAudio ? 'block' : 'none';
        });
        video.addEventListener('volumechange', () => {
            volume.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';
        });

        const stream = this.querySelector('.stream');
        stream.style.display = this.config.streams.length > 1 ? 'block' : 'none';
    }

    renderShortcuts() {
        if (!this.config.shortcuts) return;

        const card = this.querySelector('.card');
        card.insertAdjacentHTML('beforebegin', `
            <style>
                .shortcuts {
                    position: absolute;
                    top: 5px;
                    left: 5px;
                }
            </style>
        `);
        card.insertAdjacentHTML('beforeend', '<div class="shortcuts"></div>');

        const shortcuts = this.querySelector('.shortcuts');
        shortcuts.addEventListener('click', ev => {
            const value = this.config.shortcuts[ev.target.dataset.index];
            if (value.more_info !== undefined) {
                const event = new Event('hass-more-info', {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                });
                event.detail = {entityId: value.more_info};
                ev.target.dispatchEvent(event);
            }
            if (value.service !== undefined) {
                const [domain, name] = value.service.split('.');
                this.hass.callService(domain, name, value.service_data || {});
            }
        });

        this.renderTemplate('shortcuts', () => {
            const innerHTML = this.config.shortcuts.map((value, index) => `
                <ha-icon data-index="${index}" icon="${value.icon}" title="${value.name}"></ha-icon>
            `).join('');

            if (shortcuts.innerHTML !== innerHTML) {
                shortcuts.innerHTML = innerHTML;
            }
        });
    }

    renderStyle() {
        if (!this.config.style) return;

        const style = document.createElement('style');
        const card = this.querySelector('.card');
        card.insertAdjacentElement('beforebegin', style);

        this.renderTemplate('style', () => {
            style.innerText = this.config.style;
        });
    }

    renderTemplate(name, renderHTML) {
        const config = this.config[name];
        // support config param as string or as object
        const template = typeof config === 'string' ? config : JSON.stringify(config);
        // check if config param has template
        if (template.indexOf('${') >= 0) {
            const render = () => {
                try {
                    const states = this.hass ? this.hass.states : undefined;
                    this.config[name] = JSON.parse(eval('`' + template + '`'));
                    renderHTML();
                } catch (e) {
                    console.debug(e);
                }
            };
            this.onhass.push(render);
            render();
        } else {
            renderHTML();
        }
    }

    get hasAudio() {
        return (
            (this.video.srcObject && this.video.srcObject.getAudioTracks && this.video.srcObject.getAudioTracks().length) ||
            (this.video.mozHasAudio || this.video.webkitAudioDecodedByteCount) ||
            (this.video.audioTracks && this.video.audioTracks.length)
        );
    }
}

customElements.define('webrtc-camera-sfenton', WebRTCCamera);

const card = {
    type: 'webrtc-camera-sfenton',
    name: 'WebRTC Camera',
    preview: false,
    description: 'WebRTC camera allows you to view the stream of almost any camera without delay',
};
// Apple iOS 12 doesn't support `||=`
if (window.customCards) window.customCards.push(card);
else window.customCards = [card];

