import { installGatewayWorkerProtocolHost } from "@openclaw/gateway-client/browser";
import { signGatewayWorkerDevice } from "./gateway-worker-device.ts";

installGatewayWorkerProtocolHost(self, {
  extension: (method, value) => {
    if (method === "sign-device") return signGatewayWorkerDevice(value);
    throw new Error(`Unknown worker extension: ${method}`);
  },
});
