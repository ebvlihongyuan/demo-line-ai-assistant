import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import express, { type Request } from "express";
import { isTrustedWindowsRequest, isValidLocalAccessToken, isAuthorizedLocalApiRequest, windowsLocalProtection } from "./_core/localAccess";
import { appRouter } from "./routers";

const originalEnv = { ...process.env };
const context = { req: { headers: {}, socket: {} }, res: {}, user: null } as any;
const caller = appRouter.createCaller(context);

beforeEach(() => {
  process.env.MANUS_API_URL = "https://api.deepseek.com";
  process.env.MANUS_API_KEY = "test-key";
  process.env.MANUS_API_MODEL = "deepseek-flash";
  process.env.MANUS_API_PROVIDER = "deepseek";
});
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("local-first privacy boundary", () => {
  it("rejects missing or false consent and rejects history/excerpts as extra input", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(caller.chat.askExternal({ question: "你好", consent: false } as any)).rejects.toThrow();
    await expect(caller.chat.askExternal({ question: "你好" } as any)).rejects.toThrow();
    await expect(caller.chat.askExternal({ question: "你好", consent: true, history: ["机密内容"] } as any)).rejects.toThrow();
    await expect(caller.chat.askExternal({ question: "你好", consent: true, excerpts: ["机密内容"] } as any)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends exactly one question and fixed instruction, with no local content or history", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "一般性回答" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(caller.chat.askExternal({ question: "传感器怎样选型？", consent: true })).resolves.toEqual({ text: "一般性回答" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe("deepseek-flash");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "传感器怎样选型？" });
    expect(JSON.stringify(body)).not.toContain("机密内容");
  });

  it("does not automatically resend an authorized request when the provider errors", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));
    await expect(caller.chat.askExternal({ question: "请解答", consent: true })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not call a model when local knowledge is unavailable", async () => {
    if (process.platform === "win32") return; // This suite's fake request is not a trusted local browser.
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(caller.localKnowledge.search({ question: "电机温度" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("no longer exposes the old history-forwarding reply procedure", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect((caller.chat as any).reply({ messages: [{ role: "user", content: "secret" }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Windows request validation", () => {
  it("requires the current unguessable local access code", () => {
    expect(isValidLocalAccessToken("wrong", "correct-secret")).toBe(false);
    expect(isValidLocalAccessToken(undefined, "correct-secret")).toBe(false);
    expect(isValidLocalAccessToken("correct-secret", "correct-secret")).toBe(true);
    expect(isValidLocalAccessToken("old-secret", "new-secret")).toBe(false);
  });
  function request(overrides: { remote?: string; host?: string; origin?: string; site?: string; forwarded?: string } = {}): Request {
    return {
      socket: { remoteAddress: overrides.remote ?? "127.0.0.1", localPort: 3000 },
      headers: { host: overrides.host ?? "127.0.0.1:3000", ...(overrides.origin ? { origin: overrides.origin } : {}), ...(overrides.site ? { "sec-fetch-site": overrides.site } : {}), ...(overrides.forwarded ? { "x-forwarded-for": overrides.forwarded } : {}) },
    } as unknown as Request;
  }
  it("allows only a local socket, approved Host, and same origin", () => {
    expect(isTrustedWindowsRequest(request({ origin: "http://127.0.0.1:3000", site: "same-origin" }))).toBe(true);
    expect(isTrustedWindowsRequest(request({ remote: "192.168.1.2" }))).toBe(false);
    expect(isTrustedWindowsRequest(request({ host: "evil.example:3000" }))).toBe(false);
    expect(isTrustedWindowsRequest(request({ origin: "https://evil.example" }))).toBe(false);
    expect(isTrustedWindowsRequest(request({ site: "cross-site" }))).toBe(false);
    expect(isTrustedWindowsRequest(request({ forwarded: "192.168.1.2" }))).toBe(false);
  });
  it("does not authorize a local request without the secret access code", () => {
    const req = request();
    expect(isAuthorizedLocalApiRequest(req, "correct-secret")).toBe(false);
    req.headers["x-local-assistant"] = "1";
    req.headers["x-local-access"] = "wrong-secret";
    expect(isAuthorizedLocalApiRequest(req, "correct-secret")).toBe(false);
    req.headers["x-local-access"] = "correct-secret";
    expect(isAuthorizedLocalApiRequest(req, "correct-secret")).toBe(true);
    req.headers.origin = "https://evil.example";
    expect(isAuthorizedLocalApiRequest(req, "correct-secret")).toBe(false);
  });
  it("blocks unauthorized, cross-site and rebinding HTTP requests while allowing the current code", async () => {
    const app = express();
    app.use(windowsLocalProtection("correct-secret", false));
    app.get("/api/trpc/localKnowledge.list", (_req, res) => res.json({ ok: true }));
    app.get("/api/local-session/verify", (_req, res) => res.json({ ok: true }));
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing listener");
      const base = `http://127.0.0.1:${address.port}`;
      const correct = { "X-Local-Assistant": "1", "X-Local-Access": "correct-secret" };
      expect((await fetch(`${base}/api/trpc/localKnowledge.list`)).status).toBe(403);
      expect((await fetch(`${base}/api/trpc/localKnowledge.list`, { headers: { ...correct, "X-Local-Access": "wrong" } })).status).toBe(403);
      expect((await fetch(`${base}/api/local-session/verify`, { headers: correct })).status).toBe(200);
      expect((await fetch(`${base}/api/local-session/verify`, { headers: { ...correct, Origin: "https://evil.example" } })).status).toBe(403);
      // Node fetch normalizes Host; use node:http to send an actual hostile Host header.
      const rebindingStatus = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${base}/api/local-session/verify`, { headers: { ...correct, host: `evil.example:${address.port}` } }, response => {
          response.resume();
          resolve(response.statusCode || 0);
        });
        request.on("error", reject);
        request.end();
      });
      expect(rebindingStatus).toBe(403);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
