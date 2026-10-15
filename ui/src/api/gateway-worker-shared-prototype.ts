import { createGatewaySyntheticSharedWorkerHost } from "@openclaw/gateway-client/browser";
import { signGatewayWorkerDevice } from "./gateway-worker-device.ts";

const host = createGatewaySyntheticSharedWorkerHost({
  extension: (method, value) => {
    if (method === "sign-device") return signGatewayWorkerDevice(value);
    throw new Error(`Unknown worker extension: ${method}`);
  },
});
self.addEventListener("connect", (event: MessageEvent) => host.attach(event.ports[0]!));
