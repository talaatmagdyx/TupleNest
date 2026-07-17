import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { osName } from "./lib/platform";
import "./styles.css";

/* Set before the first render, not from an effect: `[data-tn-os="macos"]` is
   what reserves the titlebar space for the traffic lights, and a missing inset
   on frame one is a visible jump. */
document.documentElement.setAttribute("data-tn-os", osName());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
