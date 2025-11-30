import {beforeEach, describe, expect, it, vi} from 'vitest';

await import('../custom_components/webrtc/www/webrtc-camera.js');

const CARD_TAG = 'webrtc-camera-sfenton';

const baseConfig = {
    url: 'front_door',
    streams: [{url: 'front_door'}],
    ui: false,
    digital_ptz: false,
};

const createCamera = (overrides = {}) => {
    const el = document.createElement(CARD_TAG);
    el.setConfig({...baseConfig, ...overrides});
    el.oninit();
    return el;
};

const mountCamera = (overrides = {}) => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const camera = document.createElement(CARD_TAG);
    camera.setConfig({...baseConfig, ...overrides});
    wrapper.appendChild(camera);
    return camera;
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

    it('toggle mute helper switches audio state and emits event', () => {
        const camera = createCamera({card_id: 'popup'});
        const handler = vi.fn();
        camera.addEventListener('webrtc-audio-state', handler);

        camera.video.muted = false;
        camera.handleToggleMuteRequest({target_id: 'popup'});
        expect(camera.video.muted).toBe(true);
        expect(handler).toHaveBeenCalled();

        handler.mockClear();
        camera.handleToggleMuteRequest({target_id: 'popup'});
        expect(camera.video.muted).toBe(false);
        expect(handler).toHaveBeenCalled();
    });

    it('global screenshot events only trigger the targeted camera', () => {
        const popupCamera = mountCamera({card_id: 'popup'});
        const pageCamera = mountCamera({card_id: 'page'});

        const popupSpy = vi.spyOn(popupCamera, 'saveScreenshot').mockImplementation(() => {});
        const pageSpy = vi.spyOn(pageCamera, 'saveScreenshot').mockImplementation(() => {});

        window.dispatchEvent(new CustomEvent('webrtc-screenshot', {
            detail: {target_id: 'popup'},
        }));

        expect(popupSpy).toHaveBeenCalledTimes(1);
        expect(pageSpy).not.toHaveBeenCalled();
    });

    it('global mute and toggle events only affect the matching camera', () => {
        const popupCamera = mountCamera({card_id: 'popup'});
        const pageCamera = mountCamera({card_id: 'page'});

        popupCamera.video.muted = false;
        pageCamera.video.muted = false;

        window.dispatchEvent(new CustomEvent('webrtc-mute', {
            detail: {target_id: 'popup'},
        }));

        expect(popupCamera.video.muted).toBe(true);
        expect(pageCamera.video.muted).toBe(false);

        window.dispatchEvent(new CustomEvent('webrtc-toggle-mute', {
            detail: {target_id: 'popup'},
        }));

        expect(popupCamera.video.muted).toBe(false);
        expect(pageCamera.video.muted).toBe(false);
    });

    it('global events without filters are ignored', () => {
        const camera = mountCamera();
        camera.video.muted = false;

        window.dispatchEvent(new CustomEvent('webrtc-mute'));

        expect(camera.video.muted).toBe(false);
    });

    it('events dispatched from the camera are not handled twice', () => {
        const camera = mountCamera({card_id: 'popup'});
        const spy = vi.spyOn(camera, 'saveScreenshot').mockImplementation(() => {});

        camera.dispatchEvent(new CustomEvent('webrtc-screenshot', {
            bubbles: true,
            composed: true,
            detail: {target_id: 'popup'},
        }));

        expect(spy).toHaveBeenCalledTimes(1);
    });
});
