import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { randomBytes } from "node:crypto";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { publicPlatformScript } from "./publicConfig";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { windowsLocalProtection } from "./localAccess";

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Never save this per-process secret to a file or return it over HTTP.
  const localAccessToken = process.platform === "win32" ? randomBytes(24).toString("base64url") : "";
  if (process.platform === "win32") {
    app.use(windowsLocalProtection(localAccessToken, process.env.NODE_ENV === "development"));
  }
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.get("/api/local-session/mode", (_req, res) => res.set("Cache-Control", "no-store").json({ requiresToken: process.platform === "win32" }));
  app.get("/api/local-session/verify", (_req, res) => res.set("Cache-Control", "no-store").json({ ok: true }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/platform/config.js", (_req, res) => {
    res.set("Cache-Control", "no-store").type("application/javascript").send(publicPlatformScript());
  });
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  server.on("error", error => { console.error("Server failed:", error.message); process.exit(1); });
  const host = process.platform === "win32" ? "127.0.0.1" : "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`Server listening on ${host}:${port}`);
    if (localAccessToken) console.log(`本机访问码：${localAccessToken}\n请在此电脑的浏览器页面输入访问码，不要分享给其他人。每次重启会更换访问码。`);
  });
}

startServer().catch(error => { console.error(error); process.exit(1); });
