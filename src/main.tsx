import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";

// 描画外(非同期処理・Worker)のエラーも画面に出す
function showGlobalError(msg: string) {
  let el = document.getElementById("global-error");
  if (!el) {
    el = document.createElement("div");
    el.id = "global-error";
    el.className = "global-error";
    document.body.appendChild(el);
  }
  el.textContent = msg;
}
window.addEventListener("error", (e) => showGlobalError(`エラー: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => showGlobalError(`エラー(非同期): ${String((e.reason as Error)?.message ?? e.reason)}`));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
