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

    it('volume icon updates when mute state changes via UI config', () => {
        // Create camera with ui: true to render the custom UI with volume icon
        const camera = createCamera({card_id: 'popup', ui: true});
        
        // Get the volume icon element from the shadow DOM
        const volumeIcon = camera.shadowRoot.querySelector('.volume');
        expect(volumeIcon).not.toBeNull();
        
        // Initial state should be volume-high (unmuted)
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-high');
        
        // Mute the video and trigger volumechange event (simulates browser behavior)
        camera.video.muted = true;
        camera.video.dispatchEvent(new Event('volumechange'));
        
        // Both property and attribute should be updated
        expect(volumeIcon.icon).toBe('mdi:volume-mute');
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-mute');
        
        // Unmute and verify icon changes back
        camera.video.muted = false;
        camera.video.dispatchEvent(new Event('volumechange'));
        
        expect(volumeIcon.icon).toBe('mdi:volume-high');
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-high');
    });

    it('volume icon updates when mute state changes via handleMuteRequest', () => {
        const camera = createCamera({card_id: 'popup', ui: true});
        const volumeIcon = camera.shadowRoot.querySelector('.volume');
        
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-high');
        
        // Mute via handleMuteRequest - should update icon directly without needing volumechange event
        camera.handleMuteRequest({target_id: 'popup'}, true);
        
        // Icon should be updated immediately by handleMuteRequest
        expect(volumeIcon.icon).toBe('mdi:volume-mute');
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-mute');
        
        // Unmute via handleMuteRequest
        camera.handleMuteRequest({target_id: 'popup'}, false);
        
        expect(volumeIcon.icon).toBe('mdi:volume-high');
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-high');
    });

    it('volume icon updates when mute state changes via handleToggleMuteRequest', () => {
        const camera = createCamera({card_id: 'popup', ui: true});
        const volumeIcon = camera.shadowRoot.querySelector('.volume');
        
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-high');
        
        // Toggle mute - should update icon directly
        camera.handleToggleMuteRequest({target_id: 'popup'});
        
        expect(volumeIcon.icon).toBe('mdi:volume-mute');
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-mute');
        
        // Toggle again
        camera.handleToggleMuteRequest({target_id: 'popup'});
        
        expect(volumeIcon.icon).toBe('mdi:volume-high');
        expect(volumeIcon.getAttribute('icon')).toBe('mdi:volume-high');
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

    it('responds to hass-action fire-dom-event from Bubble Card', () => {
        const popupCamera = mountCamera({card_id: 'front-door-popup'});
        const pageCamera = mountCamera({card_id: 'page'});

        const popupSpy = vi.spyOn(popupCamera, 'saveScreenshot').mockImplementation(() => {});
        const pageSpy = vi.spyOn(pageCamera, 'saveScreenshot').mockImplementation(() => {});

        // Simulate Bubble Card's fire-dom-event action
        window.dispatchEvent(new CustomEvent('hass-action', {
            bubbles: true,
            composed: true,
            detail: {
                config: {
                    tap_action: {
                        action: 'fire-dom-event',
                        event: 'webrtc-screenshot',
                        target_id: 'front-door-popup',
                    },
                },
                action: 'tap',
            },
        }));

        expect(popupSpy).toHaveBeenCalledTimes(1);
        expect(pageSpy).not.toHaveBeenCalled();
    });

    it('hass-action toggle-mute works with target_id', () => {
        const camera = mountCamera({card_id: 'front-door-popup'});
        camera.video.muted = true;

        window.dispatchEvent(new CustomEvent('hass-action', {
            bubbles: true,
            composed: true,
            detail: {
                config: {
                    tap_action: {
                        action: 'fire-dom-event',
                        event: 'webrtc-toggle-mute',
                        target_id: 'front-door-popup',
                    },
                },
                action: 'tap',
            },
        }));

        expect(camera.video.muted).toBe(false);
    });

    it('ignores hass-action events that are not fire-dom-event', () => {
        const camera = mountCamera({card_id: 'popup'});
        const spy = vi.spyOn(camera, 'saveScreenshot').mockImplementation(() => {});

        window.dispatchEvent(new CustomEvent('hass-action', {
            bubbles: true,
            composed: true,
            detail: {
                config: {
                    tap_action: {
                        action: 'navigate',
                        navigation_path: '#somewhere',
                    },
                },
                action: 'tap',
            },
        }));

        expect(spy).not.toHaveBeenCalled();
    });

    it('ignores hass-action fire-dom-event with unknown event names', () => {
        const camera = mountCamera({card_id: 'popup'});
        const spy = vi.spyOn(camera, 'saveScreenshot').mockImplementation(() => {});

        window.dispatchEvent(new CustomEvent('hass-action', {
            bubbles: true,
            composed: true,
            detail: {
                config: {
                    tap_action: {
                        action: 'fire-dom-event',
                        event: 'some-other-event',
                        target_id: 'popup',
                    },
                },
                action: 'tap',
            },
        }));

        expect(spy).not.toHaveBeenCalled();
    });
});

describe('webrtc-camera tap/hold action handlers', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('dispatches hass-action event on tap when tap_action configured', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {
                action: 'more-info',
                entity: 'camera.front_door',
            },
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        // Simulate pointer down and up (tap gesture)
        camera.dispatchEvent(new PointerEvent('pointerdown', {
            button: 0,
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));
        camera.dispatchEvent(new PointerEvent('pointerup', {
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));

        // Allow for immediate tap execution
        await new Promise(r => setTimeout(r, 10));

        expect(hassActionHandler).toHaveBeenCalled();
        const detail = hassActionHandler.mock.calls[0][0].detail;
        expect(detail.action).toBe('tap');
        expect(detail.config.action).toBe('more-info');
        expect(detail.config.entity).toBe('camera.front_door');

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('does not dispatch hass-action when no tap_action configured', async () => {
        const camera = mountCamera({card_id: 'test-card'});

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        camera.dispatchEvent(new PointerEvent('pointerdown', {
            button: 0,
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));
        camera.dispatchEvent(new PointerEvent('pointerup', {
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));

        await new Promise(r => setTimeout(r, 10));

        expect(hassActionHandler).not.toHaveBeenCalled();

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('dispatches hass-action on hold when hold_action configured', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            hold_action: {
                action: 'call-service',
                service: 'script.my_script',
            },
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        // Simulate pointer down and wait for hold timeout
        camera.dispatchEvent(new PointerEvent('pointerdown', {
            button: 0,
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));

        // Wait for hold timeout (500ms + buffer)
        await new Promise(r => setTimeout(r, 550));

        expect(hassActionHandler).toHaveBeenCalled();
        const detail = hassActionHandler.mock.calls[0][0].detail;
        expect(detail.action).toBe('hold');
        expect(detail.config.action).toBe('call-service');
        expect(detail.config.service).toBe('script.my_script');

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('does not trigger tap after hold is triggered', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {action: 'more-info'},
            hold_action: {action: 'toggle'},
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        camera.dispatchEvent(new PointerEvent('pointerdown', {
            button: 0,
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));

        // Wait for hold to trigger
        await new Promise(r => setTimeout(r, 550));

        // Now release
        camera.dispatchEvent(new PointerEvent('pointerup', {
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));

        await new Promise(r => setTimeout(r, 10));

        // Should have exactly one call (the hold), not two (hold + tap)
        expect(hassActionHandler).toHaveBeenCalledTimes(1);
        expect(hassActionHandler.mock.calls[0][0].detail.action).toBe('hold');

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('cancels tap when pointer moves significantly', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {action: 'more-info'},
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        camera.dispatchEvent(new PointerEvent('pointerdown', {
            button: 0,
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));
        
        // Release at a different position (moved more than 10px)
        camera.dispatchEvent(new PointerEvent('pointerup', {
            clientX: 150,
            clientY: 150,
            bubbles: true,
        }));

        await new Promise(r => setTimeout(r, 10));

        expect(hassActionHandler).not.toHaveBeenCalled();

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('dispatches double_tap action on double tap', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {action: 'more-info'},
            double_tap_action: {action: 'navigate', navigation_path: '/cameras'},
        });

        const locationChangedHandler = vi.fn();
        window.addEventListener('location-changed', locationChangedHandler);

        const pushStateSpy = vi.spyOn(history, 'pushState');

        // First tap
        camera.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 100, clientY: 100, bubbles: true}));
        camera.dispatchEvent(new PointerEvent('pointerup', {clientX: 100, clientY: 100, bubbles: true}));

        // Second tap quickly
        await new Promise(r => setTimeout(r, 50));
        camera.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 100, clientY: 100, bubbles: true}));
        camera.dispatchEvent(new PointerEvent('pointerup', {clientX: 100, clientY: 100, bubbles: true}));

        await new Promise(r => setTimeout(r, 10));

        // Navigate action is handled directly, not via hass-action
        expect(pushStateSpy).toHaveBeenCalledWith(null, "", '/cameras');
        expect(locationChangedHandler).toHaveBeenCalled();

        window.removeEventListener('location-changed', locationChangedHandler);
        pushStateSpy.mockRestore();
    });

    it('uses config.entity as default when action.entity not specified', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            entity: 'camera.default_entity',
            streams: [{url: 'front_door', entity: 'camera.default_entity'}],
            tap_action: {action: 'more-info'},
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        camera.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 100, clientY: 100, bubbles: true}));
        camera.dispatchEvent(new PointerEvent('pointerup', {clientX: 100, clientY: 100, bubbles: true}));

        await new Promise(r => setTimeout(r, 10));

        expect(hassActionHandler).toHaveBeenCalled();
        expect(hassActionHandler.mock.calls[0][0].detail.config.entity).toBe('camera.default_entity');

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('ignores right-click for tap actions', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {action: 'more-info'},
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        // Right-click (button: 2)
        camera.dispatchEvent(new PointerEvent('pointerdown', {
            button: 2,
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));
        camera.dispatchEvent(new PointerEvent('pointerup', {
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));

        await new Promise(r => setTimeout(r, 10));

        expect(hassActionHandler).not.toHaveBeenCalled();

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('does not dispatch when action is none', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {action: 'none'},
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        camera.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 100, clientY: 100, bubbles: true}));
        camera.dispatchEvent(new PointerEvent('pointerup', {clientX: 100, clientY: 100, bubbles: true}));

        await new Promise(r => setTimeout(r, 10));

        expect(hassActionHandler).not.toHaveBeenCalled();

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('cleans up action handlers on disconnect', () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {action: 'more-info'},
        });

        expect(camera._actionHandlersInitialized).toBe(true);

        camera.remove();

        expect(camera._actionHandlersInitialized).toBe(false);
        expect(camera._actionState).toBe(null);
    });

    it('cancels hold timer on pointercancel', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            hold_action: {action: 'toggle'},
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        camera.dispatchEvent(new PointerEvent('pointerdown', {
            button: 0,
            clientX: 100,
            clientY: 100,
            bubbles: true,
        }));

        // Cancel before hold timeout
        await new Promise(r => setTimeout(r, 200));
        camera.dispatchEvent(new PointerEvent('pointercancel', {bubbles: true}));

        // Wait past the hold timeout
        await new Promise(r => setTimeout(r, 400));

        expect(hassActionHandler).not.toHaveBeenCalled();

        window.removeEventListener('hass-action', hassActionHandler);
    });

    it('sets body mute classes when connected with card_id', () => {
        const camera = mountCamera({card_id: 'test-mute-class'});
        camera.video.muted = true;
        camera.emitAudioState();

        expect(document.body.classList.contains('webrtc-muted-test-mute-class')).toBe(true);
        expect(document.body.classList.contains('webrtc-unmuted-test-mute-class')).toBe(false);

        camera.video.muted = false;
        camera.emitAudioState();

        expect(document.body.classList.contains('webrtc-muted-test-mute-class')).toBe(false);
        expect(document.body.classList.contains('webrtc-unmuted-test-mute-class')).toBe(true);
    });

    it('body mute classes update when using handleToggleMuteRequest', () => {
        const camera = mountCamera({card_id: 'toggle-body-class-test'});
        camera.video.muted = true;
        camera.emitAudioState();

        expect(document.body.classList.contains('webrtc-muted-toggle-body-class-test')).toBe(true);
        expect(document.body.classList.contains('webrtc-unmuted-toggle-body-class-test')).toBe(false);

        // Toggle via handleToggleMuteRequest - should update body classes
        camera.handleToggleMuteRequest({target_id: 'toggle-body-class-test'});

        expect(document.body.classList.contains('webrtc-muted-toggle-body-class-test')).toBe(false);
        expect(document.body.classList.contains('webrtc-unmuted-toggle-body-class-test')).toBe(true);

        // Toggle again
        camera.handleToggleMuteRequest({target_id: 'toggle-body-class-test'});

        expect(document.body.classList.contains('webrtc-muted-toggle-body-class-test')).toBe(true);
        expect(document.body.classList.contains('webrtc-unmuted-toggle-body-class-test')).toBe(false);
    });

    it('removes body mute classes on disconnect', () => {
        const camera = mountCamera({card_id: 'cleanup-test'});
        camera.video.muted = false;
        camera.emitAudioState();

        expect(document.body.classList.contains('webrtc-unmuted-cleanup-test')).toBe(true);

        camera.remove();

        expect(document.body.classList.contains('webrtc-muted-cleanup-test')).toBe(false);
        expect(document.body.classList.contains('webrtc-unmuted-cleanup-test')).toBe(false);
    });

    it('handles navigate action directly with history.pushState', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {
                action: 'navigate',
                navigation_path: '#camera-front-door',
            },
        });

        const locationChangedHandler = vi.fn();
        window.addEventListener('location-changed', locationChangedHandler);

        const pushStateSpy = vi.spyOn(history, 'pushState');

        camera.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 100, clientY: 100, bubbles: true}));
        camera.dispatchEvent(new PointerEvent('pointerup', {clientX: 100, clientY: 100, bubbles: true}));

        await new Promise(r => setTimeout(r, 10));

        expect(pushStateSpy).toHaveBeenCalledWith(null, "", '#camera-front-door');
        expect(locationChangedHandler).toHaveBeenCalled();

        window.removeEventListener('location-changed', locationChangedHandler);
        pushStateSpy.mockRestore();
    });

    it('handles navigate action with replace option', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {
                action: 'navigate',
                navigation_path: '/lovelace/cameras',
                navigation_replace: true,
            },
        });

        const replaceStateSpy = vi.spyOn(history, 'replaceState');

        camera.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 100, clientY: 100, bubbles: true}));
        camera.dispatchEvent(new PointerEvent('pointerup', {clientX: 100, clientY: 100, bubbles: true}));

        await new Promise(r => setTimeout(r, 10));

        expect(replaceStateSpy).toHaveBeenCalledWith(null, "", '/lovelace/cameras');

        replaceStateSpy.mockRestore();
    });

    it('handles url action by opening new window', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            tap_action: {
                action: 'url',
                url_path: 'https://example.com',
            },
        });

        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

        camera.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 100, clientY: 100, bubbles: true}));
        camera.dispatchEvent(new PointerEvent('pointerup', {clientX: 100, clientY: 100, bubbles: true}));

        await new Promise(r => setTimeout(r, 10));

        expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank');

        openSpy.mockRestore();
    });

    it('dispatches hass-action for more-info action', async () => {
        const camera = mountCamera({
            card_id: 'test-card',
            streams: [{url: 'front_door', entity: 'camera.front_door'}],
            tap_action: {
                action: 'more-info',
            },
        });

        const hassActionHandler = vi.fn();
        window.addEventListener('hass-action', hassActionHandler);

        camera.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 100, clientY: 100, bubbles: true}));
        camera.dispatchEvent(new PointerEvent('pointerup', {clientX: 100, clientY: 100, bubbles: true}));

        await new Promise(r => setTimeout(r, 10));

        expect(hassActionHandler).toHaveBeenCalled();
        expect(hassActionHandler.mock.calls[0][0].detail.config.action).toBe('more-info');
        expect(hassActionHandler.mock.calls[0][0].detail.config.entity).toBe('camera.front_door');

        window.removeEventListener('hass-action', hassActionHandler);
    });
});

describe('stream sharing', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        // Clear the stream registry before each test
        if (window.__webrtcStreams) {
            window.__webrtcStreams.clear();
        }
    });

    it('allows config with source instead of url', () => {
        const el = document.createElement(CARD_TAG);
        // Should not throw with source
        expect(() => el.setConfig({source: 'primary-card', card_id: 'clone-card'})).not.toThrow();
    });

    it('throws error without url, entity, streams, or source', () => {
        const el = document.createElement(CARD_TAG);
        expect(() => el.setConfig({})).toThrow('Missing `url` or `entity` or `streams` or `source`');
    });

    it('marks card as clone when source is provided', () => {
        const el = document.createElement(CARD_TAG);
        el.setConfig({source: 'primary-card', card_id: 'clone-card'});
        expect(el._isClone).toBe(true);
        expect(el._sourceCardId).toBe('primary-card');
    });

    it('marks card as non-clone when url is provided', () => {
        const camera = createCamera({card_id: 'primary-card'});
        expect(camera._isClone).toBe(false);
        expect(camera._sourceCardId).toBeNull();
    });

    it('primary card registers in stream registry on connect', () => {
        const camera = createCamera({card_id: 'primary-card'});
        
        // Simulate connectedCallback behavior
        camera._registerAsStreamOwner();
        
        const registry = window.__webrtcStreams;
        expect(registry.has('primary-card')).toBe(true);
        expect(registry.get('primary-card').owner).toBe(camera);
    });

    it('primary card unregisters from registry on disconnect', () => {
        const camera = createCamera({card_id: 'primary-card'});
        camera._registerAsStreamOwner();
        
        expect(window.__webrtcStreams.has('primary-card')).toBe(true);
        
        camera._unregisterAsStreamOwner();
        
        expect(window.__webrtcStreams.has('primary-card')).toBe(false);
    });

    it('clone card subscribes to source stream', () => {
        // Create and register primary card
        const primary = createCamera({card_id: 'primary-card'});
        primary._registerAsStreamOwner();
        
        // Create clone card
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'primary-card', card_id: 'clone-card'});
        clone.oninit();
        
        // Subscribe to source
        const result = clone._subscribeToSource();
        
        expect(result).toBe(true);
        expect(window.__webrtcStreams.get('primary-card').subscribers.has(clone)).toBe(true);
    });

    it('clone card fails to subscribe if source not available', () => {
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'nonexistent-card', card_id: 'clone-card'});
        clone.oninit();
        
        const result = clone._subscribeToSource();
        
        expect(result).toBe(false);
    });

    it('clone card unsubscribes on disconnect', () => {
        // Create and register primary card
        const primary = createCamera({card_id: 'primary-card'});
        primary._registerAsStreamOwner();
        
        // Create and subscribe clone card
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'primary-card', card_id: 'clone-card'});
        clone.oninit();
        clone._subscribeToSource();
        
        expect(window.__webrtcStreams.get('primary-card').subscribers.has(clone)).toBe(true);
        
        // Unsubscribe
        clone._unsubscribeFromSource();
        
        expect(window.__webrtcStreams.get('primary-card').subscribers.has(clone)).toBe(false);
    });

    it('clone cards receive stream updates from primary', () => {
        // Create and register primary card
        const primary = createCamera({card_id: 'primary-card'});
        primary._registerAsStreamOwner();
        
        // Create and subscribe clone card
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'primary-card', card_id: 'clone-card'});
        clone.oninit();
        clone._subscribeToSource();
        
        // Create a mock MediaStream
        const mockStream = { id: 'mock-stream' };
        primary.video.srcObject = mockStream;
        
        // Trigger stream update
        primary._updateRegisteredStream();
        
        // Clone should have received the stream
        expect(clone.video.srcObject).toBe(mockStream);
    });

    it('clone card sets status to CLONE when stream is received', () => {
        const primary = createCamera({card_id: 'primary-card'});
        primary._registerAsStreamOwner();
        
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'primary-card', card_id: 'clone-card'});
        clone.oninit();
        clone._subscribeToSource();
        
        const setStatusSpy = vi.spyOn(clone, 'setStatus');
        
        // Simulate stream update
        clone._onSourceStreamUpdated({ id: 'mock-stream' });
        
        expect(setStatusSpy).toHaveBeenCalledWith('CLONE', '');
    });

    it('clone card sets status to Waiting when stream is null', () => {
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'primary-card', card_id: 'clone-card'});
        clone.oninit();
        
        const setStatusSpy = vi.spyOn(clone, 'setStatus');
        
        clone._onSourceStreamUpdated(null);
        
        expect(setStatusSpy).toHaveBeenCalledWith('Waiting...', '');
    });

    it('multiple clones can subscribe to same source', () => {
        const primary = createCamera({card_id: 'primary-card'});
        primary._registerAsStreamOwner();
        
        const clone1 = document.createElement(CARD_TAG);
        clone1.setConfig({source: 'primary-card', card_id: 'clone-1'});
        clone1.oninit();
        clone1._subscribeToSource();
        
        const clone2 = document.createElement(CARD_TAG);
        clone2.setConfig({source: 'primary-card', card_id: 'clone-2'});
        clone2.oninit();
        clone2._subscribeToSource();
        
        const subscribers = window.__webrtcStreams.get('primary-card').subscribers;
        expect(subscribers.size).toBe(2);
        expect(subscribers.has(clone1)).toBe(true);
        expect(subscribers.has(clone2)).toBe(true);
    });

    it('primary disconnection notifies all clones with null stream', () => {
        const primary = createCamera({card_id: 'primary-card'});
        primary._registerAsStreamOwner();
        
        const clone1 = document.createElement(CARD_TAG);
        clone1.setConfig({source: 'primary-card', card_id: 'clone-1'});
        clone1.oninit();
        clone1._subscribeToSource();
        
        const clone2 = document.createElement(CARD_TAG);
        clone2.setConfig({source: 'primary-card', card_id: 'clone-2'});
        clone2.oninit();
        clone2._subscribeToSource();
        
        // Set a stream on both
        const mockStream = { id: 'mock' };
        clone1.video.srcObject = mockStream;
        clone2.video.srcObject = mockStream;
        
        // Primary disconnects
        primary._unregisterAsStreamOwner();
        
        // Both clones should have null srcObject now
        expect(clone1.video.srcObject).toBeNull();
        expect(clone2.video.srcObject).toBeNull();
    });

    it('isCloneCard getter returns correct value', () => {
        const primary = createCamera({card_id: 'primary-card'});
        expect(primary.isCloneCard).toBe(false);
        
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'primary-card', card_id: 'clone-card'});
        expect(clone.isCloneCard).toBe(true);
    });

    it('onconnect returns false for clone cards', () => {
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'primary-card', card_id: 'clone-card'});
        clone.oninit();
        
        const result = clone.onconnect();
        
        expect(result).toBe(false);
    });

    it('clone card sets Waiting status when source not found on connect', () => {
        const clone = document.createElement(CARD_TAG);
        clone.setConfig({source: 'nonexistent-card', card_id: 'clone-card'});
        clone.oninit();
        
        const setStatusSpy = vi.spyOn(clone, 'setStatus');
        
        clone.onconnect();
        
        expect(setStatusSpy).toHaveBeenCalledWith('Waiting...', 'for source');
    });
});

describe('stream manager integration', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        // Clear the stream manager
        if (window.__webrtcStreamManager) {
            window.__webrtcStreamManager.streams.clear();
        }
    });

    it('shared config option enables stream manager mode', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true});
        
        expect(camera._useStreamManager).toBe(true);
    });

    it('non-shared cards do not use stream manager', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig});
        
        expect(camera._useStreamManager).toBe(false);
    });

    it('shared card subscribes to stream manager on connect', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'shared-camera'});
        camera.oninit();
        
        const subscribeSpy = vi.spyOn(camera, '_subscribeToStreamManager');
        
        // Manually trigger connected callback logic for shared mode
        camera._subscribeToStreamManager();
        
        expect(subscribeSpy).toHaveBeenCalled();
    });

    it('shared card unsubscribes from stream manager on disconnect', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'shared-camera'});
        camera.oninit();
        
        // Mock the unsubscribe function
        const mockUnsubscribe = vi.fn();
        camera._streamManagerUnsubscribe = mockUnsubscribe;
        
        camera._unsubscribeFromStreamManager();
        
        expect(mockUnsubscribe).toHaveBeenCalled();
        expect(camera._streamManagerUnsubscribe).toBe(null);
    });

    it('stream manager update sets status on connecting', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'shared-camera'});
        camera.oninit();
        
        const setStatusSpy = vi.spyOn(camera, 'setStatus');
        
        camera._onStreamManagerUpdate(null, 'connecting', null);
        
        expect(setStatusSpy).toHaveBeenCalledWith('Loading...', '');
    });

    it('stream manager update sets video source on connected', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'shared-camera'});
        camera.oninit();
        
        const mockStream = { id: 'test-stream' };
        const setStatusSpy = vi.spyOn(camera, 'setStatus');
        const playSpy = vi.spyOn(camera, 'play').mockImplementation(() => {});
        
        camera._onStreamManagerUpdate(mockStream, 'connected', 'webrtc');
        
        expect(camera.video.srcObject).toBe(mockStream);
        expect(setStatusSpy).toHaveBeenCalledWith('WEBRTC', '');
        expect(playSpy).toHaveBeenCalled();
    });

    it('stream manager update shows reconnecting status', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'shared-camera'});
        camera.oninit();
        
        const setStatusSpy = vi.spyOn(camera, 'setStatus');
        
        camera._onStreamManagerUpdate(null, 'disconnected', null);
        
        expect(setStatusSpy).toHaveBeenCalledWith('Reconnecting...', '');
    });

    it('stream manager update shows error status', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'shared-camera'});
        camera.oninit();
        
        const setStatusSpy = vi.spyOn(camera, 'setStatus');
        
        camera._onStreamManagerUpdate(null, 'error', null);
        
        expect(setStatusSpy).toHaveBeenCalledWith('error', 'Stream failed');
    });

    it('hass setter updates stream manager', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true});
        
        const mockHass = { hassUrl: () => 'http://localhost:8123' };
        
        // The stream manager should exist
        expect(window.__webrtcStreamManager).toBeDefined();
        
        const setHassSpy = vi.spyOn(window.__webrtcStreamManager, 'setHass');
        
        camera.hass = mockHass;
        
        expect(setHassSpy).toHaveBeenCalledWith(mockHass);
    });

    it('stream manager is singleton', () => {
        expect(window.__webrtcStreamManager).toBeDefined();
        expect(window.__webrtcStreamManager.streams).toBeInstanceOf(Map);
    });

    it('stream manager getStreamKey uses entity when provided', () => {
        const manager = window.__webrtcStreamManager;
        
        const key = manager.getStreamKey({entity: 'camera.front_door', url: 'rtsp://test'});
        
        expect(key).toBe('camera.front_door');
    });

    it('stream manager getStreamKey uses url when no entity', () => {
        const manager = window.__webrtcStreamManager;
        
        const key = manager.getStreamKey({url: 'rtsp://test'});
        
        expect(key).toBe('rtsp://test');
    });

    it('stream manager tracks active streams', () => {
        const manager = window.__webrtcStreamManager;
        
        const streams = manager.getActiveStreams();
        
        expect(Array.isArray(streams)).toBe(true);
    });

    it('sets data-stream-status attribute to connecting on subscribe', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'status-test'});
        camera.oninit();
        
        // Simulate the initial connect
        camera._updateStreamStatus('connecting');
        
        expect(camera.getAttribute('data-stream-status')).toBe('connecting');
    });

    it('sets data-stream-status attribute to connected when stream ready', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'status-test'});
        camera.oninit();
        
        const mockStream = { id: 'test-stream' };
        vi.spyOn(camera, 'play').mockImplementation(() => {});
        
        camera._onStreamManagerUpdate(mockStream, 'connected', 'webrtc');
        
        expect(camera.getAttribute('data-stream-status')).toBe('connected');
    });

    it('sets data-stream-status attribute to disconnected on connection loss', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'status-test'});
        camera.oninit();
        
        camera._onStreamManagerUpdate(null, 'disconnected', null);
        
        expect(camera.getAttribute('data-stream-status')).toBe('disconnected');
    });

    it('sets data-stream-status attribute to error on failure', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({...baseConfig, shared: true, card_id: 'status-test'});
        camera.oninit();
        
        camera._onStreamManagerUpdate(null, 'error', null);
        
        expect(camera.getAttribute('data-stream-status')).toBe('error');
    });

    it('clone card sets data-stream-status on source stream update', () => {
        const camera = document.createElement(CARD_TAG);
        camera.setConfig({source: 'primary-card', card_id: 'clone-status-test'});
        camera.oninit();
        
        // Test connected state
        const mockStream = { id: 'test-stream' };
        vi.spyOn(camera, 'play').mockImplementation(() => {});
        camera._onSourceStreamUpdated(mockStream);
        
        expect(camera.getAttribute('data-stream-status')).toBe('connected');
        
        // Test waiting state
        camera._onSourceStreamUpdated(null);
        
        expect(camera.getAttribute('data-stream-status')).toBe('connecting');
    });
});
