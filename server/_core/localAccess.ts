import { stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { TRPCError } from "@trpc/server";

export const WINDOWS_KNOWLEDGE_DIRECTORY = "D:\\示范线知识库";

/** The randomly generated access code is held only by the server and authorized browser memory. */
export function isValidLocalAccessToken(value: unknown, expected: string): boolean {
  if (typeof value !== "string" || !expected || value.length !== expected.length) return false;
  const supplied = Buffer.from(value, "utf8");
  const valid = Buffer.from(expected, "utf8");
  return supplied.length === valid.length && timingSafeEqual(supplied, valid);
}

/** A loopback listener alone is insufficient: reject DNS rebinding and cross-site requests. */
export function isTrustedWindowsRequest(req: Request): boolean {
  const address = req.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  if (req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers["x-forwarded-proto"]) return false;
  const port = req.socket.localPort;
  const host = req.headers.host?.toLowerCase();
  if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return false;
  const origin = req.headers.origin;
  if (origin && origin.toLowerCase() !== `http://${host}`) return false;
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}

export function isAuthorizedLocalApiRequest(req: Request, token: string): boolean {
  return isTrustedWindowsRequest(req) && req.headers["x-local-assistant"] === "1" &&
    isValidLocalAccessToken(req.headers["x-local-access"], token);
}

/** Use only for the Windows loopback listener, never for Cloud Preview. */
export function windowsLocalProtection(token: string, development: boolean): RequestHandler {
  return (req, res, next) => {
    const scripts = development ? "'self' 'unsafe-inline'" : "'self'";
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`);
    res.setHeader("Cache-Control", "no-store");
    if (!isTrustedWindowsRequest(req)) return res.status(403).send("Forbidden");
    if ((req.path.startsWith("/api/trpc") || req.path === "/api/local-session/verify") &&
        !isAuthorizedLocalApiRequest(req, token)) return res.status(403).send("Forbidden");
    next();
  };
}

export function requireLocalApiRequest(req: Request): void {
  if (process.platform !== "win32" || !isTrustedWindowsRequest(req) || req.headers["x-local-assistant"] !== "1") {
    throw new TRPCError({ code: "FORBIDDEN", message: "本机知识库只能通过此电脑的本机页面访问。" });
  }
}

export async function localKnowledgeAvailability(req: Request): Promise<{available: boolean; directory: string; reason?: string}> {
  if (process.platform !== "win32") {
    return { available: false, directory: WINDOWS_KNOWLEDGE_DIRECTORY, reason: "请在 Windows 电脑本机运行更新后的程序；云端网页无法访问您电脑的 D 盘。" };
  }
  requireLocalApiRequest(req);
  try {
    const drive = await stat("D:\\");
    if (!drive.isDirectory()) throw new Error("drive unavailable");
    return { available: true, directory: WINDOWS_KNOWLEDGE_DIRECTORY };
  } catch {
    return { available: false, directory: WINDOWS_KNOWLEDGE_DIRECTORY, reason: "无法访问 D 盘，请检查磁盘是否存在、已连接并具有访问权限。" };
  }
}

export async function requireLocalKnowledge(req: Request): Promise<void> {
  const status = await localKnowledgeAvailability(req);
  if (!status.available) throw new TRPCError({ code: "PRECONDITION_FAILED", message: status.reason || "本机知识库不可用。" });
}
