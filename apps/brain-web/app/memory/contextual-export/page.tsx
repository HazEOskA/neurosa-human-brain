import type { Metadata } from "next";
import { ContextualMemoryBridge } from "../../../components/contextual-memory-bridge";

export const metadata: Metadata = {
  title: "Contextual Memory Bridge | neurosa.ai · OSA HIVE",
  description: "Import i lokalne udostępnianie kontekstu — NeurOSA × OSA HIVE.",
};

export default function ContextualExportPage() {
  return <ContextualMemoryBridge />;
}
