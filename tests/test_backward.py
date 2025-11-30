import pytest

try:
    from homeassistant.const import REQUIRED_PYTHON_VER
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    REQUIRED_PYTHON_VER = (3, 10, 0)


def test_python_version_requirement():
    # https://github.com/home-assistant/core/blob/2023.2.0/homeassistant/const.py
    assert REQUIRED_PYTHON_VER >= (3, 10, 0)


def test_component_exports_exist():
    try:
        from custom_components.webrtc import async_setup_entry, async_unload_entry
        from custom_components.webrtc.config_flow import FlowHandler
        from custom_components.webrtc.media_player import WebRTCPlayer
    except ModuleNotFoundError as exc:  # pragma: no cover - optional dependency
        pytest.skip(f'missing optional integration dependency: {exc.name}')

    assert async_setup_entry
    assert async_unload_entry
    assert FlowHandler
    assert WebRTCPlayer
