import "@fontsource/tomorrow/latin-600.css";
import "@fontsource/tomorrow/latin-700.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const target = document.getElementById("root");
if (!target) throw new Error("Root-Element fehlt.");

createRoot(target).render(
  <React.StrictMode>
    <App surface={document.body.dataset.surface ?? "controller"} />
  </React.StrictMode>
);
