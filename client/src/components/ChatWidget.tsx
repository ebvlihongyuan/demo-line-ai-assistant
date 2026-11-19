import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, BookOpenText, ChevronDown, ExternalLink, MessageCircle, RotateCcw, Sparkles, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { trpc } from "@/lib/trpc";

type Source = { title: string; url: string; publisher: string; category: string };
type Message = { role: "user" | "assistant"; content: string; sources?: Source[]; matched?: boolean };
// Preserve existing session conversations after the visible assistant is renamed.
const STORAGE_KEY = "xiaoguang-chat-v1";
const examples = ["电机温度和振动异常应关注什么？", "环境噪声传感器如何监测？", "阀门开关状态如何预警？", "压力和液位传感器如何选用？", "传感器数据是如何采集的？", "化工质量检验如何做好追溯？"];

function loadMessages(): Message[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(item => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string").slice(-20) : [];
  } catch { return []; }
}

export function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark${small ? " brand-mark-small" : ""}`} aria-hidden="true"><Sparkles size={small ? 17 : 21} strokeWidth={2.1} /></span>;
}

export default function ChatWidget({ open, setOpen }: { open: boolean; setOpen: (value: boolean) => void }) {
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [input, setInput] = useState("");
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mutation = trpc.chat.reply.useMutation();
  const overview = trpc.knowledge.overview.useQuery(undefined, { enabled: open, staleTime: 300000 });

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages)); } catch { /* storage is optional */ }
    if (messages.length || pending || failed) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    else if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [messages, pending, failed, open]);

  async function requestReply(history: Message[]) {
    setFailed(false);
    setPending(true);
    try {
      const answer = await mutation.mutateAsync({ messages: history.slice(-20).map(({ role, content }) => ({ role, content })) });
      setMessages(current => [...current, { role: "assistant", content: answer.text, sources: answer.sources, matched: answer.matched }]);
    } catch {
      setFailed(true);
    } finally { setPending(false); }
  }

  function send(text = input) {
    const content = text.trim();
    if (!content || pending || content.length > 4000) return;
    const next: Message[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    void requestReply(next);
  }

  function clearChat() {
    if (pending) return;
    if (messages.length && !window.confirm("确定清空当前对话吗？清空后无法恢复。")) return;
    setMessages([]);
    setFailed(false);
    setInput("");
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  return <div className="widget-layer">
    {open && <section className="chat-panel" aria-label="示范线AI智能助手对话框">
      <header className="chat-header">
        <div className="chat-identity"><BrandMark /><div><div className="chat-name assistant-brand">示范线AI智能助手</div><div className="online"><i /> 化工与传感知识问答</div></div></div>
        <div className="header-actions"><button onClick={clearChat} disabled={pending} title="清空对话" aria-label="清空对话"><RotateCcw size={17} /></button><button onClick={() => setOpen(false)} title="收起对话" aria-label="收起对话"><ChevronDown size={21} /></button></div>
      </header>
      <div className="knowledge-bar"><div className="knowledge-bar-top"><BookOpenText size={14} /><span>示范线知识库</span>{overview.data && <span className="knowledge-count">{overview.data.total} 条</span>}</div><div className="knowledge-fields">质量 · 设备 · 安全 · 能源 · 传感器 · 数据采集</div></div>
      <div className="chat-body" ref={bodyRef} aria-live="polite">
        <div className="date-label">和示范线助手开始对话 <span>✦</span></div>
        <div className="message-row assistant-row"><BrandMark small /><div className="assistant-content"><div className="message-author">示范线助手</div><div className="bubble assistant-bubble">你好，我是示范线AI智能助手。<br />我可以回答化工质量、设备、安全、能源以及传感器和数据采集相关问题。<br /><br /><span className="live-data-note">目前尚未连接现场实时传感器数据。</span></div></div></div>
        {messages.length === 0 && <div className="suggestion-block"><p>试试这样问</p>{examples.map(example => <button key={example} onClick={() => send(example)}><span>{example}</span><span>↗</span></button>)}</div>}
        {messages.map((message, index) => message.role === "user" ? <div className="message-row user-row" key={index}><div className="bubble user-bubble">{message.content}</div></div> : <div className="message-row assistant-row" key={index}><BrandMark small /><div className="assistant-content"><div className="message-author">示范线助手</div><div className="bubble assistant-bubble markdown-answer"><Streamdown>{message.content}</Streamdown>{message.sources && message.sources.length > 0 && <div className="source-list"><div className="source-label"><BookOpenText size={12} /> 检索到的参考资料</div>{message.sources.map((source, sourceIndex) => <a key={`${source.url}-${sourceIndex}`} href={source.url} target="_blank" rel="noreferrer noopener"><span>{source.title}<small>{source.publisher}</small></span><ExternalLink size={12} /></a>)}</div>}{message.matched === false && <div className="no-source">知识库暂无直接匹配资料，请结合可靠来源核实。</div>}</div></div></div>)}
        {pending && <div className="message-row assistant-row"><BrandMark small /><div className="assistant-content"><div className="message-author">示范线助手</div><div className="bubble assistant-bubble thinking"><span className="dots"><i /><i /><i /></span> 正在查找资料并思考</div></div></div>}
        {failed && !pending && <div className="error-message">暂时没有收到回答。<button onClick={() => void requestReply(messages)}>重新回答</button></div>}
        <div ref={bottomRef} />
      </div>
      <div className="chat-footer"><div className="composer"><textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder="输入你的问题..." aria-label="输入你的问题" rows={2} maxLength={4000} /><div className="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button onClick={() => send()} disabled={!input.trim() || pending} aria-label="发送消息" title="发送消息"><ArrowUp size={19} /></button></div></div><p className="chat-disclaimer">AI 回答仅供参考，现场操作请遵循适用规程</p></div>
    </section>}
    <button className={`chat-launcher${open ? " is-open" : ""}`} onClick={() => setOpen(!open)} aria-label={open ? "收起示范线助手" : "打开示范线助手"} aria-expanded={open}>
      <span className="launcher-icon">{open ? <X size={22} /> : <MessageCircle size={23} fill="currentColor" strokeWidth={1.8} />}</span><span className="launcher-copy">{open ? "收起对话" : "示范线助手"}</span>{!open && <span className="launcher-dot" />}
    </button>
  </div>;
}
