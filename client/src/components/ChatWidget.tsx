import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, ChevronDown, MessageCircle, RotateCcw, Sparkles, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { trpc } from "@/lib/trpc";

type Message = { role: "user" | "assistant"; content: string };
const STORAGE_KEY = "xiaoguang-chat-v1";
const examples = ["你可以帮我做什么？", "怎样快速读懂一篇文章？", "帮我梳理内容的重点"];

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mutation = trpc.chat.reply.useMutation();

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages)); } catch { /* storage is optional */ }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, failed, open]);

  async function requestReply(history: Message[]) {
    setFailed(false);
    setPending(true);
    try {
      const answer = await mutation.mutateAsync({ messages: history.slice(-20) });
      setMessages(current => [...current, { role: "assistant", content: answer.text }]);
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
    {open && <section className="chat-panel" aria-label="小光 AI 智能客服对话框">
      <header className="chat-header">
        <div className="chat-identity"><BrandMark /><div><div className="chat-name">小光 <span>AI 智能客服</span></div><div className="online"><i /> 随时为你解答</div></div></div>
        <div className="header-actions"><button onClick={clearChat} disabled={pending} title="清空对话" aria-label="清空对话"><RotateCcw size={17} /></button><button onClick={() => setOpen(false)} title="收起对话" aria-label="收起对话"><ChevronDown size={21} /></button></div>
      </header>
      <div className="chat-body" aria-live="polite">
        <div className="date-label">和小光开始对话 <span>✦</span></div>
        <div className="message-row assistant-row"><BrandMark small /><div className="assistant-content"><div className="message-author">小光</div><div className="bubble assistant-bubble">你好，我是小光。<br />有什么想了解的，尽管问我。<br /><br />也可以把内容发给我，我来帮你梳理重点。</div></div></div>
        {messages.length === 0 && <div className="suggestion-block"><p>试试这样问</p>{examples.map(example => <button key={example} onClick={() => send(example)}><span>{example}</span><span>↗</span></button>)}</div>}
        {messages.map((message, index) => message.role === "user" ? <div className="message-row user-row" key={index}><div className="bubble user-bubble">{message.content}</div></div> : <div className="message-row assistant-row" key={index}><BrandMark small /><div className="assistant-content"><div className="message-author">小光</div><div className="bubble assistant-bubble markdown-answer"><Streamdown>{message.content}</Streamdown></div></div></div>)}
        {pending && <div className="message-row assistant-row"><BrandMark small /><div className="assistant-content"><div className="message-author">小光</div><div className="bubble assistant-bubble thinking"><span className="dots"><i /><i /><i /></span> 正在思考中</div></div></div>}
        {failed && !pending && <div className="error-message">暂时没有收到回答。<button onClick={() => void requestReply(messages)}>重新回答</button></div>}
        <div ref={bottomRef} />
      </div>
      <div className="chat-footer"><div className="composer"><textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder="输入你的问题..." aria-label="输入你的问题" rows={2} maxLength={4000} /><div className="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button onClick={() => send()} disabled={!input.trim() || pending} aria-label="发送消息" title="发送消息"><ArrowUp size={19} /></button></div></div><p className="chat-disclaimer">内容由 AI 生成，请注意甄别</p></div>
    </section>}
    <button className={`chat-launcher${open ? " is-open" : ""}`} onClick={() => setOpen(!open)} aria-label={open ? "收起小光客服" : "打开小光客服"} aria-expanded={open}>
      <span className="launcher-icon">{open ? <X size={22} /> : <MessageCircle size={23} fill="currentColor" strokeWidth={1.8} />}</span><span className="launcher-copy">{open ? "收起对话" : "和小光聊聊"}</span>{!open && <span className="launcher-dot" />}
    </button>
  </div>;
}
