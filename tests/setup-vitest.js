class StubWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor() {
        this.readyState = StubWebSocket.CONNECTING;
        this.listeners = {};
    }

    addEventListener(type, handler) {
        this.listeners[type] = handler;
    }

    close() {}

    send() {}
}

if (!globalThis.WebSocket) {
    globalThis.WebSocket = StubWebSocket;
}
