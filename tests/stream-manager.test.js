import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';

// Import stream manager directly
const { WebRTCStreamManager, streamManager } = await import(
    '../custom_components/webrtc/www/stream-manager.js'
);

describe('WebRTCStreamManager', () => {
    let manager;

    beforeEach(() => {
        manager = new WebRTCStreamManager();
    });

    afterEach(() => {
        // Clean up any streams
        manager.streams.forEach((_, key) => {
            manager._closeStream(key);
        });
    });

    // --- Key derivation ---
    it('getStreamKey prefers entity over url', () => {
        expect(manager.getStreamKey({entity: 'camera.front', url: 'rtsp://host'}))
            .toBe('camera.front');
    });

    it('getStreamKey falls back to url', () => {
        expect(manager.getStreamKey({url: 'rtsp://host'})).toBe('rtsp://host');
    });

    it('getStreamKey returns undefined for empty config', () => {
        expect(manager.getStreamKey({})).toBeUndefined();
    });

    // --- setHass ---
    it('setHass stores hass and propagates to existing entries', () => {
        const config = {url: 'rtsp://test'};
        const entry = manager._createStreamEntry('test', config);
        manager.streams.set('test', entry);

        const mockHass = {hassUrl: () => 'http://localhost'};
        manager.setHass(mockHass);

        expect(manager._hass).toBe(mockHass);
        expect(entry.hass).toBe(mockHass);
    });

    // --- _createStreamEntry ---
    it('_createStreamEntry creates a well-formed entry', () => {
        const entry = manager._createStreamEntry('test-key', {
            url: 'rtsp://cam1',
            entity: null,
            mode: 'webrtc',
            media: 'video',
        });

        expect(entry.key).toBe('test-key');
        expect(entry.url).toBe('rtsp://cam1');
        expect(entry.status).toBe('idle');
        expect(entry.subscribers).toBeInstanceOf(Set);
        expect(entry.subscribers.size).toBe(0);
        expect(entry.video).toBeInstanceOf(HTMLVideoElement);
        expect(entry.video.muted).toBe(true);
        expect(entry.config.mode).toBe('webrtc');
    });

    it('_createStreamEntry uses default mode when not specified', () => {
        const entry = manager._createStreamEntry('k', {url: 'rtsp://x'});
        expect(entry.config.mode).toBe('webrtc,mse,hls,mjpeg');
    });

    // --- subscribe / unsubscribe ---
    it('subscribe calls error callback for empty config', () => {
        const cb = vi.fn();
        const unsub = manager.subscribe({}, cb);

        expect(cb).toHaveBeenCalledWith(null, 'error', null);
        expect(typeof unsub).toBe('function');
    });

    it('subscribe creates entry and returns unsubscribe function', () => {
        manager.setHass({
            hassUrl: () => 'http://localhost',
            callWS: vi.fn().mockRejectedValue(new Error('no auth')),
        });

        const cb = vi.fn();
        const unsub = manager.subscribe({url: 'rtsp://cam1'}, cb);

        expect(manager.streams.has('rtsp://cam1')).toBe(true);
        expect(manager.streams.get('rtsp://cam1').subscribers.has(cb)).toBe(true);

        unsub();
        expect(manager.streams.get('rtsp://cam1').subscribers.has(cb)).toBe(false);
    });

    it('subscribe notifies immediately if stream already connected', () => {
        const url = 'rtsp://cam-connected';
        const entry = manager._createStreamEntry(url, {url});
        entry.stream = {id: 'mock-stream'};
        entry.status = 'connected';
        entry.mode = 'webrtc';
        entry.ws = {close: vi.fn()}; // pretend already connected
        manager.streams.set(url, entry);

        const cb = vi.fn();
        manager.subscribe({url}, cb);

        // First call should be the immediate notification with the existing stream
        expect(cb).toHaveBeenCalledWith({id: 'mock-stream'}, 'connected', 'webrtc');
    });

    it('subscribe notifies connecting status if entry is connecting', () => {
        const url = 'rtsp://cam-connecting';
        const entry = manager._createStreamEntry(url, {url});
        entry.status = 'connecting';
        entry.ws = {close: vi.fn()}; // pretend ws exists
        manager.streams.set(url, entry);

        const cb = vi.fn();
        manager.subscribe({url}, cb);

        expect(cb).toHaveBeenCalledWith(null, 'connecting', null);
    });

    // --- _notifySubscribers ---
    it('_notifySubscribers calls all subscribers', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        entry.subscribers.add(cb1);
        entry.subscribers.add(cb2);

        const mockStream = {id: 's'};
        manager._notifySubscribers(entry, mockStream, 'connected', 'webrtc');

        expect(cb1).toHaveBeenCalledWith(mockStream, 'connected', 'webrtc');
        expect(cb2).toHaveBeenCalledWith(mockStream, 'connected', 'webrtc');
    });

    it('_notifySubscribers catches subscriber errors', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        const badCb = vi.fn(() => { throw new Error('boom'); });
        const goodCb = vi.fn();
        entry.subscribers.add(badCb);
        entry.subscribers.add(goodCb);

        // Should not throw
        expect(() => {
            manager._notifySubscribers(entry, null, 'error', null);
        }).not.toThrow();

        expect(goodCb).toHaveBeenCalled();
    });

    // --- _handleDisconnect ---
    it('_handleDisconnect resets entry and notifies subscribers', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.ws = {close: vi.fn()};
        entry.pc = {close: vi.fn()};
        entry.stream = {id: 's'};
        manager.streams.set('key', entry);

        const cb = vi.fn();
        entry.subscribers.add(cb);

        manager._handleDisconnect(entry);

        expect(entry.ws).toBeNull();
        expect(entry.pc).toBeNull();
        expect(entry.stream).toBeNull();
        expect(entry.status).toBe('disconnected');
        expect(cb).toHaveBeenCalledWith(null, 'disconnected', null);
    });

    // --- _scheduleReconnect ---
    it('_scheduleReconnect respects max attempts', () => {
        vi.useFakeTimers();
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.reconnectAttempts = manager.maxReconnectAttempts;
        manager.streams.set('key', entry);

        const cb = vi.fn();
        entry.subscribers.add(cb);

        manager._scheduleReconnect(entry);

        expect(entry.status).toBe('error');
        expect(cb).toHaveBeenCalledWith(null, 'error', null);
        vi.useRealTimers();
    });

    it('_scheduleReconnect uses exponential backoff', () => {
        vi.useFakeTimers();
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.reconnectAttempts = 2; // 3rd attempt: delay = 2000 * 2^2 = 8000
        manager.streams.set('key', entry);
        entry.subscribers.add(vi.fn());

        const connectSpy = vi.spyOn(manager, '_connect').mockImplementation(() => {});
        manager._scheduleReconnect(entry);

        expect(entry.reconnectAttempts).toBe(3);

        // Should not have connected yet
        vi.advanceTimersByTime(7999);
        expect(connectSpy).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(connectSpy).toHaveBeenCalled();

        vi.useRealTimers();
    });

    it('keeps the existing MSE retry reset when its signaling socket opens', () => {
        const entry = manager._createStreamEntry('key', {url: 'x', mode: 'mse'});
        entry.reconnectAttempts = 4;
        entry.ws = {close: vi.fn()};
        manager.streams.set('key', entry);
        const requestMse = vi.spyOn(manager, '_requestMSE').mockImplementation(() => {});

        manager._onWsOpen(entry);

        expect(entry.reconnectAttempts).toBe(0);
        expect(requestMse).toHaveBeenCalledWith(entry);
    });

    // --- _closeStream ---
    it('_closeStream cleans up all resources', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.ws = {close: vi.fn()};
        entry.pc = {close: vi.fn()};
        entry.reconnectTimer = 12345;
        const {ws, pc} = entry;
        manager.streams.set('key', entry);

        manager._closeStream('key');

        expect(manager.streams.has('key')).toBe(false);
        expect(ws.close).toHaveBeenCalled();
        expect(pc.close).toHaveBeenCalled();
    });

    // --- getStreamStatus / getActiveStreams ---
    it('getStreamStatus returns null for unknown key', () => {
        expect(manager.getStreamStatus('nonexistent')).toBeNull();
    });

    it('getStreamStatus returns correct status', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.status = 'connected';
        entry.mode = 'webrtc';
        entry.subscribers.add(vi.fn());
        entry.subscribers.add(vi.fn());
        manager.streams.set('key', entry);

        const status = manager.getStreamStatus('key');
        expect(status.status).toBe('connected');
        expect(status.mode).toBe('webrtc');
        expect(status.subscriberCount).toBe(2);
    });

    it('getActiveStreams returns all streams', () => {
        manager.streams.set('a', manager._createStreamEntry('a', {url: 'x'}));
        manager.streams.set('b', manager._createStreamEntry('b', {url: 'y'}));

        const active = manager.getActiveStreams();
        expect(active.length).toBe(2);
        expect(active.map(s => s.key).sort()).toEqual(['a', 'b']);
    });

    // --- reconnect ---
    it('reconnect resets attempts and re-connects', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.reconnectAttempts = 3;
        entry.ws = {close: vi.fn()};
        entry.subscribers.add(vi.fn());
        manager.streams.set('key', entry);

        const connectSpy = vi.spyOn(manager, '_connect').mockImplementation(() => {});
        manager.reconnect('key');

        expect(entry.reconnectAttempts).toBe(0);
        expect(connectSpy).toHaveBeenCalledWith(entry);
    });

    // --- _handleJsonMessage ---
    it('_handleJsonMessage handles webrtc/answer', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.pc = {
            setRemoteDescription: vi.fn(),
        };

        manager._handleJsonMessage(entry, {
            type: 'webrtc/answer',
            value: 'v=0\r\n...',
        });

        expect(entry.pc.setRemoteDescription).toHaveBeenCalledWith({
            type: 'answer',
            sdp: 'v=0\r\n...',
        });
    });

    it('_handleJsonMessage buffers ICE candidates until the answer is applied', async () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.pc = {
            setRemoteDescription: vi.fn().mockResolvedValue(),
            addIceCandidate: vi.fn().mockResolvedValue(),
            close: vi.fn(),
        };
        manager.streams.set('key', entry);

        manager._handleJsonMessage(entry, {
            type: 'webrtc/candidate',
            value: 'candidate:1234',
        });
        expect(entry.pc.addIceCandidate).not.toHaveBeenCalled();

        manager._handleJsonMessage(entry, {
            type: 'webrtc/answer',
            value: 'v=0\r\n...',
        });
        await vi.waitFor(() => {
            expect(entry.pc.addIceCandidate).toHaveBeenCalledWith({
                candidate: 'candidate:1234',
                sdpMid: '0',
            });
        });

        expect(entry.pendingCandidates).toHaveLength(0);
    });

    it('_handleJsonMessage handles error', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        const cb = vi.fn();
        entry.subscribers.add(cb);
        manager.streams.set('key', entry);

        manager._handleJsonMessage(entry, {
            type: 'error',
            value: 'something broke',
        });

        expect(entry.status).toBe('disconnected');
        expect(cb).toHaveBeenCalledWith(null, 'disconnected', null);
    });
});

describe('shared RTC recovery', () => {
    let manager;
    let sockets;
    let peers;
    let hass;
    let originalVisibility;

    beforeEach(() => {
        originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
        vi.useFakeTimers();
        sockets = [];
        peers = [];
        class FakeSocket {
            static OPEN = 1;
            static CLOSED = 3;

            constructor(url) {
                this.url = url;
                this.readyState = 0;
                this.sent = [];
                sockets.push(this);
            }

            open() {
                this.readyState = FakeSocket.OPEN;
                this.onopen?.();
            }

            send(message) {
                this.sent.push(JSON.parse(message));
            }

            close() {
                this.readyState = FakeSocket.CLOSED;
                this.onclose?.();
            }
        }
        class FakePeer {
            constructor() {
                this.connectionState = 'new';
                this.iceConnectionState = 'new';
                this.frames = 0;
                this.closed = false;
                this.addTransceiver = vi.fn();
                this.createOffer = vi.fn().mockResolvedValue({sdp: 'v=0'});
                this.setLocalDescription = vi.fn().mockResolvedValue();
                this.setRemoteDescription = vi.fn().mockResolvedValue();
                this.addIceCandidate = vi.fn().mockResolvedValue();
                this.getStats = vi.fn(async () => new Map([['video', {
                    type: 'inbound-rtp', kind: 'video', framesDecoded: this.frames,
                }]]));
                peers.push(this);
            }

            close() {
                this.closed = true;
                this.connectionState = 'closed';
            }
        }
        vi.stubGlobal('WebSocket', FakeSocket);
        vi.stubGlobal('RTCPeerConnection', FakePeer);
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
        manager = new WebRTCStreamManager();
        hass = {
            connection: new EventTarget(),
            callWS: vi.fn().mockResolvedValue({path: '/api/webrtc/ws?authSig=test'}),
            hassUrl: path => 'http://ha.test' + path,
        };
        manager.setHass(hass);
    });

    afterEach(() => {
        for (const key of manager.streams.keys()) manager._closeStream(key);
        manager.setHass(null);
        if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
        else delete document.visibilityState;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    async function startStream(callback = vi.fn()) {
        const unsubscribe = manager.subscribe({
            entity: 'camera.test',
            media: 'video,audio',
            mode: 'webrtc',
        }, callback);
        await vi.advanceTimersByTimeAsync(0);
        const socket = sockets.at(-1);
        socket.open();
        await vi.advanceTimersByTimeAsync(0);
        const peer = peers.at(-1);
        const tracks = [{kind: 'video', id: 'video'}];
        const stream = {
            getTracks: () => tracks,
            getAudioTracks: () => tracks.filter(track => track.kind === 'audio'),
            addTrack: track => tracks.push(track),
        };
        peer.ontrack({streams: [stream], track: tracks[0]});
        peer.connectionState = 'connected';
        peer.iceConnectionState = 'connected';
        peer.onconnectionstatechange();
        return {unsubscribe, socket, peer, stream, callback};
    }

    async function receiveFrame(peer) {
        peer.frames++;
        await vi.advanceTimersByTimeAsync(1000);
    }

    it('requires a decoded frame before publishing live and retains it when signaling closes', async () => {
        const {socket, peer, stream, callback} = await startStream();
        expect(peer.addTransceiver).toHaveBeenCalledWith('audio', {direction: 'recvonly'});
        expect(peer.addTransceiver).toHaveBeenCalledWith('video', {direction: 'recvonly'});
        expect(socket.sent).toContainEqual({type: 'webrtc/offer', value: 'v=0'});
        expect(callback).not.toHaveBeenCalledWith(stream, 'connected', 'webrtc');

        await receiveFrame(peer);
        expect(callback).toHaveBeenCalledWith(stream, 'connected', 'webrtc');
        socket.close();
        await receiveFrame(peer);

        expect(peer.closed).toBe(false);
        expect(manager.getStreamStatus('camera.test').status).toBe('connected');
        expect(sockets).toHaveLength(1);
        expect(hass.callWS).toHaveBeenCalledTimes(1);
    });

    it('does not replace an advancing peer when the main HA connection becomes ready again', async () => {
        const {socket, peer} = await startStream();
        await receiveFrame(peer);
        socket.close();

        hass.connection.dispatchEvent(new Event('ready'));
        await receiveFrame(peer);

        expect(peer.closed).toBe(false);
        expect(hass.callWS).toHaveBeenCalledTimes(1);
        expect(sockets).toHaveLength(1);
    });

    it('recovers a stalled peer after signaling closes without reloading the document', async () => {
        const {socket, peer, callback} = await startStream();
        await receiveFrame(peer);
        const video = manager.streams.get('camera.test').video;
        socket.close();

        await vi.advanceTimersByTimeAsync(10000);

        expect(peer.closed).toBe(true);
        expect(sockets).toHaveLength(2);
        expect(manager.streams.get('camera.test').video).toBe(video);
        expect(callback).toHaveBeenCalledWith(null, 'disconnected', null);
    });

    it('keeps advancing frames across transient ICE loss but replaces a failed peer', async () => {
        const {peer} = await startStream();
        await receiveFrame(peer);
        peer.connectionState = 'disconnected';
        peer.onconnectionstatechange();
        peer.frames++;
        await vi.advanceTimersByTimeAsync(2000);
        peer.connectionState = 'connected';
        peer.onconnectionstatechange();
        await vi.advanceTimersByTimeAsync(3000);
        expect(peer.closed).toBe(false);
        expect(sockets).toHaveLength(1);

        peer.connectionState = 'failed';
        peer.onconnectionstatechange();
        expect(peer.closed).toBe(true);
        await vi.advanceTimersByTimeAsync(2000);
        expect(sockets).toHaveLength(2);
    });

    it('does not label a resumed peer Live until another video frame decodes', async () => {
        let visibility = 'visible';
        Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
        const {peer, stream, callback} = await startStream();
        await receiveFrame(peer);
        const entry = manager.streams.get('camera.test');

        visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(2000);
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));

        expect(entry.video.srcObject).toBe(stream);
        expect(entry.status).toBe('connecting');
        expect(callback).toHaveBeenLastCalledWith(null, 'connecting', null);
        await vi.advanceTimersByTimeAsync(7000);
        expect(entry.status).toBe('connecting');
        expect(peer.closed).toBe(false);

        peer.frames++;
        await vi.advanceTimersByTimeAsync(1000);
        expect(entry.status).toBe('connected');
        expect(peer.closed).toBe(false);
        expect(callback).toHaveBeenLastCalledWith(stream, 'connected', 'webrtc');
    });

    it('recovers a frozen peer after returning to the visible dashboard', async () => {
        let visibility = 'visible';
        Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
        const {peer} = await startStream();
        await receiveFrame(peer);

        visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(8000);

        expect(peer.closed).toBe(true);
        expect(manager.getStreamStatus('camera.test').status).toBe('disconnected');
    });

    it('restarts a connection that never decodes its first video frame', async () => {
        const {peer} = await startStream();
        await vi.advanceTimersByTimeAsync(17000);
        expect(peer.closed).toBe(true);
        expect(sockets).toHaveLength(2);
    });

    it('preserves audio tracks when the camera delivers audio in another stream', async () => {
        const {peer, stream, callback} = await startStream();
        const audio = {kind: 'audio', id: 'audio'};
        peer.ontrack({streams: [{getTracks: () => [audio]}], track: audio});
        await receiveFrame(peer);
        expect(stream.getAudioTracks()).toEqual([audio]);
        expect(callback).toHaveBeenCalledWith(stream, 'connected', 'webrtc');
    });

    it('sets media only once when video and audio ontrack events share a stream', async () => {
        const {peer, stream} = await startStream();
        const entry = manager.streams.get('camera.test');
        let assigned = 0;
        let srcObject = entry.video.srcObject;
        Object.defineProperty(entry.video, 'srcObject', {
            configurable: true,
            get: () => srcObject,
            set: value => { assigned++; srcObject = value; },
        });
        const audio = {kind: 'audio', id: 'audio'};

        peer.ontrack({streams: [stream], track: audio});
        await vi.advanceTimersByTimeAsync(0);

        expect(assigned).toBe(0);
        expect(entry.video.play).toHaveBeenCalledTimes(1);
        expect(stream.getAudioTracks()).toEqual([audio]);
        expect(peer.closed).toBe(false);
    });

    it('uses rendered-frame quality when receiver stats omit decoded video frames', async () => {
        const {peer, stream, callback} = await startStream();
        const video = manager.streams.get('camera.test').video;
        peer.getStats.mockResolvedValue(new Map([['video', {type: 'inbound-rtp', kind: 'video'}]]));
        Object.defineProperty(video, 'getVideoPlaybackQuality', {
            configurable: true,
            value: () => ({totalVideoFrames: 1}),
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(callback).toHaveBeenCalledWith(stream, 'connected', 'webrtc');
    });

    it('rejects incompatible video-only sharing instead of silently dropping requested audio', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        manager.subscribe({entity: 'camera.test', mode: 'webrtc', media: 'video'}, vi.fn());
        await vi.advanceTimersByTimeAsync(0);
        const audioSubscriber = vi.fn();

        manager.subscribe({entity: 'camera.test', mode: 'webrtc', media: 'video,audio'}, audioSubscriber);

        expect(audioSubscriber).toHaveBeenCalledWith(null, 'error', null);
        expect(log).toHaveBeenCalledWith('[StreamManager] Incompatible shared stream configuration');
        expect(sockets).toHaveLength(1);
        log.mockRestore();
    });

    it('ignores a late signing response and stale socket close after a new connection', async () => {
        let resolveSigning;
        hass.callWS.mockImplementationOnce(() => new Promise(resolve => { resolveSigning = resolve; }));
        manager.subscribe({entity: 'camera.test', mode: 'webrtc'}, vi.fn());
        manager._closeStream('camera.test');
        resolveSigning({path: '/api/webrtc/ws?authSig=test'});
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets).toHaveLength(0);

        const {socket, peer} = await startStream();
        await receiveFrame(peer);
        const staleClose = socket.onclose;
        manager.reconnect('camera.test');
        await vi.advanceTimersByTimeAsync(0);
        staleClose();
        expect(sockets).toHaveLength(2);
        expect(manager.streams.get('camera.test').ws).toBe(sockets[1]);
    });

    it('times out a signing request that never settles, then retries with a fresh generation', async () => {
        let resolveStale;
        hass.callWS.mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }));
        manager.subscribe({entity: 'camera.test', mode: 'webrtc'}, vi.fn());

        await vi.advanceTimersByTimeAsync(12000);
        expect(hass.callWS).toHaveBeenCalledTimes(2);
        expect(sockets).toHaveLength(1);

        resolveStale({path: '/api/webrtc/ws?authSig=stale'});
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets).toHaveLength(1);
        expect(manager.streams.get('camera.test').ws).toBe(sockets[0]);
    });

    it('abandons pending signing on background and resumes without a stale WebSocket', async () => {
        let visibility = 'visible';
        Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
        let resolveStale;
        hass.callWS.mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }));
        manager.subscribe({entity: 'camera.test', mode: 'webrtc'}, vi.fn());

        visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        expect(manager.getStreamStatus('camera.test').status).toBe('disconnected');
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets).toHaveLength(1);

        resolveStale({path: '/api/webrtc/ws?authSig=stale'});
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets).toHaveLength(1);
    });

    it('retries signing failures up to the limit and resumes only on HA ready', async () => {
        hass.callWS.mockRejectedValue(new Error('HA unavailable'));
        manager.subscribe({entity: 'camera.test', mode: 'webrtc'}, vi.fn());
        await vi.advanceTimersByTimeAsync(62000);
        expect(manager.getStreamStatus('camera.test').status).toBe('error');
        expect(hass.callWS).toHaveBeenCalledTimes(6);

        hass.callWS.mockResolvedValue({path: '/api/webrtc/ws?authSig=test'});
        hass.connection.dispatchEvent(new Event('ready'));
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets).toHaveLength(1);
    });

    it('reuses a shared stream across a quick unmount and bounds hidden retention', async () => {
        let visibility = 'visible';
        Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
        const {peer, unsubscribe} = await startStream();
        await receiveFrame(peer);
        unsubscribe();
        const replacement = vi.fn();
        manager.subscribe({entity: 'camera.test', media: 'video,audio', mode: 'webrtc'}, replacement);
        for (let interval = 0; interval < 6; interval++) {
            peer.frames++;
            await vi.advanceTimersByTimeAsync(5000);
        }
        expect(manager.streams.has('camera.test')).toBe(true);
        expect(sockets).toHaveLength(1);
        expect(replacement).toHaveBeenCalledWith(expect.any(Object), 'connected', 'webrtc');

        visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(60000);
        expect(peer.closed).toBe(true);
        expect(sockets).toHaveLength(1);

        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets).toHaveLength(2);
    });
});

// --- Singleton ---
describe('stream manager singleton', () => {
    it('window.__webrtcStreamManager is the singleton instance', () => {
        expect(window.__webrtcStreamManager).toBe(streamManager);
    });

    it('streamManager is an instance of WebRTCStreamManager', () => {
        expect(streamManager).toBeInstanceOf(WebRTCStreamManager);
    });
});
