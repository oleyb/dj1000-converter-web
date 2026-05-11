import React from "react";
import ReactDOM from "react-dom/client";
import "98.css";

import App from "./App";
import "./index.css";
import { registerOfflineServiceWorker } from "./offline/registerOfflineServiceWorker";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerOfflineServiceWorker();
