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

if (!Event.prototype.composedPath) {
    Event.prototype.composedPath = function () {
        const path = [];
        let node = this.target;
        while (node) {
            path.push(node);
            node = node.parentNode || node.host;
        }
        path.push(window);
        return path;
    };
}
