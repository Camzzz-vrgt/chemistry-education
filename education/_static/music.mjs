(() => {
  const NativeWebSocket = window.WebSocket;

  class MusicSocket {
    constructor() {
      this.readyState = NativeWebSocket.CONNECTING;
      this.binaryType = 'arraybuffer';
      const events = {
        open: () => {
          if (this.readyState !== NativeWebSocket.CONNECTING) return;
          this.readyState = NativeWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        },
        message: value => {
          if (this.readyState !== NativeWebSocket.OPEN) return;
          const data = ArrayBuffer.isView(value) ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
          this.onmessage?.(new MessageEvent('message', { data }));
        },
        close: (code, reason) => {
          if (this.readyState === NativeWebSocket.CLOSED) return;
          this.readyState = NativeWebSocket.CLOSED;
          window.removeEventListener('pagehide', this.pagehide);
          this.onclose?.(new CloseEvent('close', { code, reason }));
        },
        error: () => this.onerror?.(new Event('error'))
      };
      this.pagehide = () => this.close();
      window.addEventListener('pagehide', this.pagehide, { once: true });
      parent.gnMusicConnect(events).then(([send, close]) => {
        this.sendTunnel = send;
        this.closeTunnel = close;
        if (this.closeArgs) close(...this.closeArgs);
      }).catch(() => {
        events.error();
        events.close(1006, 'Could not open the music connection.');
      });
    }

    send(data) {
      if (this.readyState !== NativeWebSocket.OPEN) throw new DOMException('Socket is not open.', 'InvalidStateError');
      this.sendTunnel(data);
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= NativeWebSocket.CLOSING) return;
      this.readyState = NativeWebSocket.CLOSING;
      this.closeArgs = [code, reason];
      this.closeTunnel?.(code, reason);
    }
  }

  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      const target = new URL(url, location.href);
      if (target.host === location.host && target.pathname === '/ws') return new MusicSocket();
      super(url, protocols);
    }
  };
})();
