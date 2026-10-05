import "./design/tokens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, applyTheme } from "./App";
import { desktop } from "./lib/desktop";
import { loadPrefs, usePrefs } from "./state/prefs";
import { useUi } from "./state/ui";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

document.documentElement.dataset.platform = desktop.platform;
const [appInfo] = await Promise.all([desktop.app.info(), loadPrefs()]);
useUi.setState({ appInfo });
applyTheme(usePrefs.getState().theme);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
