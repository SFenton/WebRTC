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

    // --- _closeStream ---
    it('_closeStream cleans up all resources', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.ws = {close: vi.fn()};
        entry.pc = {close: vi.fn()};
        entry.reconnectTimer = 12345;
        manager.streams.set('key', entry);

        manager._closeStream('key');

        expect(manager.streams.has('key')).toBe(false);
        expect(entry.ws.close).toHaveBeenCalled();
        expect(entry.pc.close).toHaveBeenCalled();
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

    it('_handleJsonMessage handles webrtc/candidate', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        entry.pc = {
            addIceCandidate: vi.fn(),
        };

        manager._handleJsonMessage(entry, {
            type: 'webrtc/candidate',
            value: 'candidate:1234',
        });

        expect(entry.pc.addIceCandidate).toHaveBeenCalledWith({
            candidate: 'candidate:1234',
            sdpMid: '0',
        });
    });

    it('_handleJsonMessage handles error', () => {
        const entry = manager._createStreamEntry('key', {url: 'x'});
        const cb = vi.fn();
        entry.subscribers.add(cb);

        manager._handleJsonMessage(entry, {
            type: 'error',
            value: 'something broke',
        });

        expect(entry.status).toBe('error');
        expect(cb).toHaveBeenCalledWith(null, 'error', null);
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
