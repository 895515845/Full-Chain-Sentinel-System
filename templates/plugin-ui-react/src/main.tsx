import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// The SDK is a plain script: importing it installs window.SentinelPlugin and
// starts the handshake with the console.
import "../sdk.js";
import "./style.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
