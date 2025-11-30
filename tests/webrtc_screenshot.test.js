import {beforeEach, describe, expect, it, vi} from 'vitest';

await import('../custom_components/webrtc/www/webrtc-camera.js');

const baseConfig = {
    url: 'front_door',
    streams: [{url: 'front_door'}],
    ui: false,
    digital_ptz: false,
};

const createCamera = (overrides = {}) => {
    const el = document.createElement('webrtc-camera');
    el.setConfig({...baseConfig, ...overrides});
    el.oninit();
    return el;
};

const attachBubbleBridge = (root, detail, bubbleEvent = 'bubble-screenshot', targetEvent = 'webrtc-screenshot') => {
    root.__webrtcBridges = root.__webrtcBridges || {};
    if (root.__webrtcBridges[bubbleEvent]) return;
    root.__webrtcBridges[bubbleEvent] = true;
    root.addEventListener(bubbleEvent, ev => {
        ev.stopPropagation();
        const camera = root.querySelector('webrtc-camera');
        if (!camera) return;
        camera.dispatchEvent(new CustomEvent(targetEvent, {
            bubbles: true,
            composed: true,
            detail,
        }));
    });
};

describe('webrtc-camera screenshot events', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('fires saveScreenshot when target_url matches', () => {
        const camera = createCamera();
        const spy = vi.spyOn(camera, 'saveScreenshot').mockImplementation(() => {});

        camera.dispatchEvent(new CustomEvent('webrtc-screenshot', {
            detail: {target_url: 'front_door'},
        }));

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('ignores events without filters', () => {
        const camera = createCamera();
        const spy = vi.spyOn(camera, 'saveScreenshot').mockImplementation(() => {});

        camera.dispatchEvent(new CustomEvent('webrtc-screenshot'));

        expect(spy).not.toHaveBeenCalled();
    });

    it('ignores mismatched targets', () => {
        const camera = createCamera();
        const spy = vi.spyOn(camera, 'saveScreenshot').mockImplementation(() => {});

        camera.dispatchEvent(new CustomEvent('webrtc-screenshot', {
            detail: {target_url: 'back_door'},
        }));

        expect(spy).not.toHaveBeenCalled();
    });

    it('supports targeting by custom card id', () => {
        const popupCamera = createCamera({card_id: 'popup'});
        const otherCamera = createCamera({card_id: 'page'});

        const popupSpy = vi.spyOn(popupCamera, 'saveScreenshot').mockImplementation(() => {});
        const pageSpy = vi.spyOn(otherCamera, 'saveScreenshot').mockImplementation(() => {});

        popupCamera.dispatchEvent(new CustomEvent('webrtc-screenshot', {
            detail: {target_id: 'popup'},
        }));

        expect(popupSpy).toHaveBeenCalledTimes(1);
        expect(pageSpy).not.toHaveBeenCalled();
    });

    it('bubble-card bridge triggers only popup camera when duplicate streams exist', () => {
        const popupContainer = document.createElement('div');
        document.body.appendChild(popupContainer);
        const popupCamera = createCamera({card_id: 'popup'});
        popupContainer.appendChild(popupCamera);

        const pageContainer = document.createElement('div');
        document.body.appendChild(pageContainer);
        const pageCamera = createCamera({card_id: 'page'});
        pageContainer.appendChild(pageCamera);

        const popupSpy = vi.spyOn(popupCamera, 'saveScreenshot').mockImplementation(() => {});
        const pageSpy = vi.spyOn(pageCamera, 'saveScreenshot').mockImplementation(() => {});

        attachBubbleBridge(popupContainer, {target_id: 'popup'});
        attachBubbleBridge(pageContainer, {target_id: 'page'});

        popupContainer.dispatchEvent(new CustomEvent('bubble-screenshot', {bubbles: true}));

        expect(popupSpy).toHaveBeenCalledTimes(1);
        expect(pageSpy).not.toHaveBeenCalled();
    });

    it('mutes and unmutes via events when targets match', () => {
        const camera = createCamera();
        camera.video.muted = false;

        camera.dispatchEvent(new CustomEvent('webrtc-mute', {
            detail: {target_url: 'front_door'},
        }));
        expect(camera.video.muted).toBe(true);

        camera.dispatchEvent(new CustomEvent('webrtc-unmute', {
            detail: {target_url: 'front_door'},
        }));
        expect(camera.video.muted).toBe(false);
    });

    it('ignores mute events for other cards', () => {
        const camera = createCamera();
        camera.video.muted = false;

        camera.dispatchEvent(new CustomEvent('webrtc-mute', {
            detail: {target_url: 'other'},
        }));

        expect(camera.video.muted).toBe(false);
    });

    it('requests fullscreen only for the targeted card', () => {
        const camera = createCamera();
        camera.requestFullscreen = vi.fn().mockResolvedValue();

        camera.dispatchEvent(new CustomEvent('webrtc-fullscreen', {
            detail: {target_url: 'front_door'},
        }));

        expect(camera.requestFullscreen).toHaveBeenCalledTimes(1);

        camera.requestFullscreen.mockClear();

        camera.dispatchEvent(new CustomEvent('webrtc-fullscreen', {
            detail: {target_url: 'other'},
        }));

        expect(camera.requestFullscreen).not.toHaveBeenCalled();
    });

    it('bubble bridge mute only affects popup camera when duplicates exist', () => {
        const popupContainer = document.createElement('div');
        document.body.appendChild(popupContainer);
        const popupCamera = createCamera({card_id: 'popup'});
        popupContainer.appendChild(popupCamera);

        const pageContainer = document.createElement('div');
        document.body.appendChild(pageContainer);
        const pageCamera = createCamera({card_id: 'page'});
        pageContainer.appendChild(pageCamera);

        popupCamera.video.muted = false;
        pageCamera.video.muted = false;

        attachBubbleBridge(popupContainer, {target_id: 'popup'}, 'bubble-mute', 'webrtc-mute');
        attachBubbleBridge(pageContainer, {target_id: 'page'}, 'bubble-mute', 'webrtc-mute');

        popupContainer.dispatchEvent(new CustomEvent('bubble-mute', {bubbles: true}));

        expect(popupCamera.video.muted).toBe(true);
        expect(pageCamera.video.muted).toBe(false);
    });

    it('emits audio state events with detail and dataset', () => {
        const camera = createCamera({card_id: 'popup'});
        const handler = vi.fn();
        camera.addEventListener('webrtc-audio-state', handler);

        camera.video.muted = true;
        camera.video.dispatchEvent(new Event('volumechange'));

        expect(camera.dataset.muted).toBe('true');
        expect(handler).toHaveBeenCalled();
        expect(handler.mock.calls[handler.mock.calls.length - 1][0].detail).toMatchObject({
            target_id: 'popup',
            target_url: 'front_door',
            muted: true,
        });

        camera.video.muted = false;
        camera.video.dispatchEvent(new Event('volumechange'));

        expect(camera.dataset.muted).toBe('false');
        expect(handler.mock.calls[handler.mock.calls.length - 1][0].detail.muted).toBe(false);
    });

    it('handleMuteRequest emits audio state even without volumechange', () => {
        const camera = createCamera({card_id: 'popup'});
        const handler = vi.fn();
        camera.addEventListener('webrtc-audio-state', handler);

        camera.handleMuteRequest({target_id: 'popup'}, true);
        expect(camera.video.muted).toBe(true);
        expect(handler).toHaveBeenCalled();
        expect(handler.mock.calls[handler.mock.calls.length - 1][0].detail.muted).toBe(true);
    });
});
