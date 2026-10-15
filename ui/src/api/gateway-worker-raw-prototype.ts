let socket: WebSocket;
self.addEventListener("message", (event: MessageEvent) => {
  const input = event.data;
  if (input.type === "init") {
    socket = new WebSocket(input.url);
    socket.addEventListener("open", () => self.postMessage({ type: "open" }));
    socket.addEventListener("message", (message) => self.postMessage(String(message.data)));
    socket.addEventListener("close", (close) =>
      self.postMessage({ type: "close", code: close.code, reason: close.reason }),
    );
    socket.addEventListener("error", () => self.postMessage({ type: "error" }));
  } else if (input.type === "send") socket.send(input.data);
  else if (input.type === "close") socket.close(input.code, input.reason);
});
