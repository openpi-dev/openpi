import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { Providers } from "./app/providers.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("OpenPI Web root is missing");

createRoot(root).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>,
);
