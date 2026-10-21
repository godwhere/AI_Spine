import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/AppShell.jsx";
import { createBrowserServices } from "./app/browser-services.js";
import { PreviewRuntimeProvider } from "./components/PreviewRuntime.jsx";
import "./complete-overlap.css";
import "./rig-workbench.css";
import "./styles.css";
import "./explorer.css";

const services = createBrowserServices({
  storageMode: ["127.0.0.1", "localhost"].includes(location.hostname) ? "shared" : "legacy",
  apiBase: "/api",
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PreviewRuntimeProvider runtime={services.preview}>
      <AppShell services={services} />
    </PreviewRuntimeProvider>
  </React.StrictMode>,
);
