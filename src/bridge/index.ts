import type { AppBridge } from "./AppBridge";
import { HttpAppBridge } from "./HttpAppBridge";
import { MockAppBridge } from "./MockAppBridge";

const useGateway = import.meta.env.PROD || import.meta.env.VITE_FIN_ALFRED_GATEWAY === "1";

export const appBridge: AppBridge = useGateway ? new HttpAppBridge() : new MockAppBridge();
