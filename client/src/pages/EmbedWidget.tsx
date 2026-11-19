import { useEffect, useState } from "react";
import ChatWidget from "@/components/ChatWidget";

/** Dedicated transparent frame used by the enterprise-site embed loader. */
export default function EmbedWidget() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("embed-mode");
    return () => document.documentElement.classList.remove("embed-mode");
  }, []);

  useEffect(() => {
    if (window.parent !== window) {
      // Only panel state crosses the frame boundary; questions and answers stay inside the frame.
      window.parent.postMessage({ type: "demo-line-assistant:resize", open }, "*");
    }
  }, [open]);

  return <ChatWidget open={open} setOpen={setOpen} />;
}
