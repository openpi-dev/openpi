import { createContext } from "react";

export const ArtifactContext = createContext<{
  open: (reference: string, parent?: string, opener?: HTMLElement) => void;
  parent?: string;
} | null>(null);
