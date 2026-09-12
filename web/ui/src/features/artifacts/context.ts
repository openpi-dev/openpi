import { createContext } from "react";

export const ArtifactContext = createContext<{
  open: (reference: string, parent?: string) => void;
  parent?: string;
} | null>(null);
