import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { localKnowledgeAvailability, requireLocalKnowledge, WINDOWS_KNOWLEDGE_DIRECTORY } from "./_core/localAccess";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { knowledgeCategories, knowledgeEntries } from "./knowledge";
import { createLocalKnowledgeStore } from "./local-knowledge";

let store: ReturnType<typeof createLocalKnowledgeStore> | undefined;
const localStore = () => store ??= createLocalKnowledgeStore(WINDOWS_KNOWLEDGE_DIRECTORY);

// This fixed instruction contains no document, excerpt, history, or user data.
const REMOTE_SYSTEM_INSTRUCTION = "你是示范线AI智能助手。请用中文简洁回答，并明确你无法访问企业本机知识库或现场实时数据，不要编造企业资料、实时读数、阈值、设备状态或来源。对于化工、安全及设备问题，请提示依据现场风险评估、适用法规、企业规程和授权专业人员判断。";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  knowledge: router({
    overview: publicProcedure.query(() => ({
      total: knowledgeEntries.length,
      categories: knowledgeCategories.map(category => ({ category, count: knowledgeEntries.filter(entry => entry.category === category).length })),
    })),
  }),
  localKnowledge: router({
    status: publicProcedure.query(({ ctx }) => localKnowledgeAvailability(ctx.req)),
    list: publicProcedure.query(async ({ ctx }) => {
      await requireLocalKnowledge(ctx.req);
      return localStore().list();
    }),
    import: publicProcedure.input(z.object({
      name: z.string().min(1).max(255),
      dataBase64: z.string().min(1).max(14_000_000),
    }).strict()).mutation(async ({ ctx, input }) => {
      await requireLocalKnowledge(ctx.req);
      return localStore().importFile(input);
    }),
    remove: publicProcedure.input(z.object({ id: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
      await requireLocalKnowledge(ctx.req);
      await localStore().remove(input.id);
      return { ok: true as const };
    }),
    search: publicProcedure.input(z.object({ question: z.string().trim().min(1).max(4000) }).strict()).mutation(async ({ ctx, input }) => {
      await requireLocalKnowledge(ctx.req);
      return { matches: await localStore().search(input.question) };
    }),
  }),
  chat: router({
    // No message array is accepted here. Old history-forwarding chat.reply was removed.
    askExternal: publicProcedure.input(z.object({ question: z.string().trim().min(1).max(4000), consent: z.literal(true) }).strict()).mutation(async ({ input }) => {
      try {
        const configuredModel = process.env.MANUS_API_MODEL?.trim();
        const deepSeek = process.env.MANUS_API_PROVIDER?.toLowerCase() === "deepseek" ||
          (configuredModel ? configuredModel.startsWith("deepseek") : /^https:\/\/api\.deepseek\.com(?:[/:]|$)/i.test(process.env.MANUS_API_URL || ""));
        const result = await invokeLLM({
          model: configuredModel || (deepSeek ? "deepseek-flash" : "gpt-6-luna"),
          maxRetries: 0,
          ...(deepSeek ? { thinking: { type: "disabled" } } : { reasoning: { effort: "none" } }),
          messages: [
            { role: "system", content: REMOTE_SYSTEM_INSTRUCTION },
            { role: "user", content: input.question },
          ],
        });
        const serviceError = (result as unknown as { error?: unknown }).error;
        if (serviceError) throw new Error("model service error");
        const content = result.choices?.[0]?.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
        if (!text.trim()) throw new Error("empty model response");
        return { text: text.trim() };
      } catch {
        // Do not log upstream error bodies: they may echo the user's question.
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "外部模型暂时无法回答，请检查 API 配置或稍后重试。" });
      }
    }),
  }),
});

export type AppRouter = typeof appRouter;
