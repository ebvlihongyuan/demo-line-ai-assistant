import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const loader = readFileSync(new URL("../client/public/embed.js", import.meta.url), "utf8");

function createHost() {
  const listeners: Record<string, (event: any) => void> = {};
  const frame: any = { style: {}, dataset: {}, contentWindow: {}, setAttribute() {} };
  let attached = false;
  let count = 0;
  const document: any = {
    currentScript: { src: "https://assistant.example.com/embed.js" },
    baseURI: "https://enterprise.example.com/",
    documentElement: { clientWidth: 1440, clientHeight: 900 },
    getElementById: () => attached ? frame : null,
    createElement: (tag: string) => { if (tag !== "iframe") throw new Error("Unexpected element"); return frame; },
    body: { appendChild: () => { attached = true; count++; } },
    addEventListener() {},
  };
  const window: any = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; },
  };
  const context = { window, document, URL };
  runInNewContext(loader, context);
  return { frame, window, listeners, context, count: () => count };
}

describe("enterprise embed loader", () => {
  it("loads the assistant iframe once with room for the closed launcher", () => {
    const host = createHost();
    expect(host.frame.src).toBe("https://assistant.example.com/widget");
    expect(host.frame.title).toBe("示范线AI智能助手");
    expect(host.frame.style.width).toBe("190px");
    expect(host.frame.style.height).toBe("72px");
    runInNewContext(loader, host.context);
    expect(host.count()).toBe(1);
  });

  it("resizes only for messages from the expected frame and origin", () => {
    const { frame, listeners, window } = createHost();
    const message = { type: "demo-line-assistant:resize", open: true };
    listeners.message({ source: frame.contentWindow, origin: "https://attacker.example", data: message });
    listeners.message({ source: {}, origin: "https://assistant.example.com", data: message });
    expect(frame.style.width).toBe("190px");
    listeners.message({ source: frame.contentWindow, origin: "https://assistant.example.com", data: message });
    expect(frame.style.width).toBe("420px");
    expect(frame.style.height).toBe("640px");
    window.innerWidth = 360;
    listeners.resize({});
    expect(frame.style.width).toBe("328px");
    listeners.message({ source: frame.contentWindow, origin: "https://assistant.example.com", data: { ...message, open: false } });
    expect(frame.style.width).toBe("190px");
  });
});
