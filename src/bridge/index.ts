import type { AppBridge } from "./AppBridge";
import { MockAppBridge } from "./MockAppBridge";
import { TauriAppBridge } from "./TauriAppBridge";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const appBridge: AppBridge = import.meta.env.DEV && !isTauri ? new MockAppBridge() : new TauriAppBridge();
