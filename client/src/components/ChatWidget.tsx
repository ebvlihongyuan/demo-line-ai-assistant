import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, BookOpenText, ChevronDown, LockKeyhole, MessageCircle, RotateCcw, Sparkles, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { trpc } from "@/lib/trpc";

type LocalMatch = { fileId: string; name: string; location: string; text: string };
type Message = { role: "user" | "assistant"; content: string; kind?: "local" | "external" | "notice"; matches?: LocalMatch[] };
type PendingConsent = { question: string; reason: string; error?: string };
const examples = ["电机温度和振动异常应关注什么？", "环境噪声传感器如何监测？", "阀门开关状态如何预警？", "压力和液位传感器如何选用？", "传感器数据是如何采集的？", "化工质量检验如何做好追溯？"];

export function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark${small ? " brand-mark-small" : ""}`} aria-hidden="true"><Sparkles size={small ? 17 : 21} strokeWidth={2.1} /></span>;
}

export default function ChatWidget({ open, setOpen }: { open: boolean; setOpen: (value: boolean) => void }) {
  // Keep questions and local excerpts in memory only, never in browser storage.
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  const pendingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const localStatus = trpc.localKnowledge.status.useQuery(undefined, { enabled: open, retry: false });
  const search = trpc.localKnowledge.search.useMutation();
  const remote = trpc.chat.askExternal.useMutation();

  useEffect(() => {
    if (messages.length || pending || consent) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    else if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [messages, pending, consent, open]);

  async function send(text = input) {
    const question = text.trim();
    if (!question || pendingRef.current || consent || question.length > 4000) return;
    pendingRef.current = true;
    setMessages(current => [...current, { role: "user", content: question }]);
    setInput("");
    setPending(true);
    try {
      // A cloud-hosted page cannot search the user's D: drive. Do not even send
      // the question to that server until the user chooses the external fallback.
      const localOrigin = window.location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(window.location.hostname);
      if (!localOrigin) {
        setConsent({ question, reason: "当前页面不在 Windows 本机服务中，无法访问本机 D 盘。" });
        return;
      }
      // Wait for an actual status response; opening the panel and sending quickly
      // must not mistake a still-loading status for a missing knowledge base.
      const status = await localStatus.refetch();
      if (status.error || !status.data?.available) {
        setConsent({ question, reason: status.data?.reason || "本机知识库暂时不可用，请检查程序和 D 盘。" });
        return;
      }
      const result = await search.mutateAsync({ question });
      if (result.matches.length) {
        setMessages(current => [...current, { role: "assistant", kind: "local", content: "在本机资料中找到以下原文摘录。请结合原文上下文核实：", matches: result.matches }]);
      } else {
        setConsent({ question, reason: "本机知识库没有找到直接匹配的内容。" });
      }
    } catch {
      // Failure is closed: the browser never automatically calls the external model.
      setConsent({ question, reason: "本机知识库暂时不可用，或检索时发生错误。请检查程序和 D 盘。" });
    } finally { pendingRef.current = false; setPending(false); }
  }

  async function approveExternal() {
    if (!consent || pendingRef.current) return;
    pendingRef.current = true;
    const question = consent.question;
    setPending(true);
    try {
      // Deliberately send just this question. No UI history, local excerpts, or files.
      const answer = await remote.mutateAsync({ question, consent: true });
      setMessages(current => [...current, { role: "assistant", kind: "external", content: answer.text }]);
      setConsent(null);
    } catch {
      setConsent(current => current && current.question === question ? { ...current, error: "外部模型暂时无法回答，请检查 API 配置。若要重试，请再次点击同意发送。" } : current);
    } finally { pendingRef.current = false; setPending(false); }
  }

  function declineExternal() {
    if (pendingRef.current) return;
    setConsent(null);
    setMessages(current => [...current, { role: "assistant", kind: "notice", content: "已取消，本次问题没有发送给外部模型。" }]);
    inputRef.current?.focus();
  }

  function clearChat() {
    if (pendingRef.current) return;
    if ((messages.length || consent) && !window.confirm("确定清空当前对话吗？清空后无法恢复。")) return;
    setMessages([]);
    setConsent(null);
    setInput("");
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return <div className="widget-layer">
    {open && <section className="chat-panel" aria-label="示范线AI智能助手对话框">
      <header className="chat-header">
        <div className="chat-identity"><BrandMark /><div><div className="chat-name assistant-brand">示范线AI智能助手</div><div className="online"><i /> 化工与传感知识问答</div></div></div>
        <div className="header-actions"><button onClick={clearChat} disabled={pending} title="清空对话" aria-label="清空对话"><RotateCcw size={17} /></button><button onClick={() => setOpen(false)} title="收起对话" aria-label="收起对话"><ChevronDown size={21} /></button></div>
      </header>
      <div className="knowledge-bar"><div className="knowledge-bar-top"><BookOpenText size={14} /><span>本机知识库优先</span><LockKeyhole size={12} /></div><div className="knowledge-fields">匹配原文不发送外部模型</div></div>
      <div className="chat-body" ref={bodyRef} aria-live="polite">
        <div className="date-label">和示范线助手开始对话 <span>✦</span></div>
        <div className="message-row assistant-row"><BrandMark small /><div className="assistant-content"><div className="message-author">示范线助手</div><div className="bubble assistant-bubble">你好，我会先检索本机知识库，找到资料时展示原文和来源。<br /><br /><span className="live-data-note">目前尚未连接现场实时传感器数据。</span></div></div></div>
        {messages.length === 0 && !consent && <div className="suggestion-block"><p>试试这样问</p>{examples.map(example => <button key={example} onClick={() => void send(example)}><span>{example}</span><span>↗</span></button>)}</div>}
        {messages.map((message, index) => message.role === "user" ? <div className="message-row user-row" key={index}><div className="bubble user-bubble">{message.content}</div></div> : <div className="message-row assistant-row" key={index}><BrandMark small /><div className="assistant-content"><div className="message-author">{message.kind === "external" ? "外部模型生成 · 请核实" : "示范线助手"}</div><div className="bubble assistant-bubble markdown-answer">
          {message.kind === "external" ? <Streamdown>{message.content}</Streamdown> : <div className="local-answer-text">{message.content}</div>}
          {message.kind === "local" && message.matches?.map((match, matchIndex) => <div className="local-excerpt" key={`${match.fileId}-${matchIndex}`}><div className="local-excerpt-source"><BookOpenText size={12} /><span>{match.name} · {match.location}<br />标识 {match.fileId}</span></div><div className="local-excerpt-text">{match.text}</div></div>)}
        </div></div></div>)}
        {pending && <div className="message-row assistant-row"><BrandMark small /><div className="assistant-content"><div className="message-author">示范线助手</div><div className="bubble assistant-bubble thinking"><span className="dots"><i /><i /><i /></span> {consent ? "正在等待外部模型回答" : "正在检索本机资料"}</div></div></div>}
        {consent && <div className="consent-card" role="group" aria-label="外部模型发送授权"><div className="consent-title"><LockKeyhole size={15} /> 是否发送本次问题？</div><p>{consent.reason}</p><p>同意后，只向已配置的外部模型（如 DeepSeek）发送<strong>本次问题</strong>和固定提示，不发送本机文件、摘录或历史对话。</p><p className="consent-warning">请注意：如果问题本身包含敏感内容，这些内容也会被发送。</p>{consent.error && <p className="consent-error">{consent.error}</p>}<div className="consent-actions"><button onClick={declineExternal} disabled={pending}>不发送</button><button className="consent-approve" onClick={() => void approveExternal()} disabled={pending}>同意发送本次问题</button></div></div>}
        <div ref={bottomRef} />
      </div>
      <div className="chat-footer"><div className="composer"><textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={consent ? "请先选择是否发送本次问题" : "输入你的问题..."} aria-label="输入你的问题" rows={2} maxLength={4000} disabled={Boolean(consent) || pending} /><div className="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button onClick={() => void send()} disabled={!input.trim() || pending || Boolean(consent)} aria-label="发送消息" title="发送消息"><ArrowUp size={19} /></button></div></div><p className="chat-disclaimer">AI 回答仅供参考，现场操作请遵循适用规程</p></div>
    </section>}
    <button className={`chat-launcher${open ? " is-open" : ""}`} onClick={() => setOpen(!open)} aria-label={open ? "收起示范线助手" : "打开示范线助手"} aria-expanded={open}>
      <span className="launcher-icon">{open ? <X size={22} /> : <MessageCircle size={23} fill="currentColor" strokeWidth={1.8} />}</span><span className="launcher-copy">{open ? "收起对话" : "示范线助手"}</span>{!open && <span className="launcher-dot" />}
    </button>
  </div>;
}
