import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";
import { appBridge } from "./bridge";

let reporting = false;
function reportBrowserError(operation: string, reason: unknown) {
  if (reporting) return;
  reporting = true;
  const message = reason instanceof Error ? reason.message : String(reason);
  void appBridge.reportClientDiagnostic({ level: "ERROR", operation, message: message.slice(0, 1_000) }).finally(() => { reporting = false; });
}
window.addEventListener("error", (event) => reportBrowserError("window.error", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportBrowserError("unhandledrejection", event.reason));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
