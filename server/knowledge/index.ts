import quality from "./quality.json";
import equipment from "./equipment.json";
import safety from "./safety.json";
import energy from "./energy.json";

export type KnowledgeEntry = {
  id: string;
  category: string;
  title: string;
  content: string;
  keywords: string[];
  sourceTitle: string;
  sourceUrl: string;
  publisher: string;
};
export type KnowledgeSource = { title: string; url: string; publisher: string; category: string };
export const knowledgeEntries: KnowledgeEntry[] = [...quality, ...equipment, ...safety, ...energy];

type ChatMessage = { role: "user" | "assistant"; content: string };
const genericPairs = new Set(["请问", "什么", "怎么", "如何", "哪些", "一下", "可以", "需要", "方面", "问题", "相关", "注意", "管理", "化工", "我们", "一个", "介绍", "了解", "详细", "内容", "这个", "那个", "怎样", "处理", "工作", "情况", "知识"]);
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");

/** Score specific terms against curated titles, keywords and passages. */
export function retrieveKnowledge(messages: ChatMessage[], limit = 5): KnowledgeEntry[] {
  const userMessages = messages.filter(message => message.role === "user");
  const latest = userMessages.at(-1)?.content || "";
  if (!latest.trim()) return [];
  // Inherit the previous topic for short referential follow-ups, not for a new named topic.
  const recent = normalize(latest);
  const namesNewTopic = ["质量", "设备", "安全", "能源", "蒸汽", "锅炉", "压力", "样品", "腐蚀", "泵", "阀", "泄漏"].some(word => recent.includes(word)) ||
    knowledgeEntries.some(entry => entry.keywords.some(keyword => keyword.length >= 3 && recent.includes(normalize(keyword))));
  const isReference = /^(那|这|它|上述|上面|刚才|然后|还有|具体|详细|进一步|继续|展开|如何|怎么|怎样|为什么|可以|是否|需要|有哪些)/.test(recent) || /呢[？?]?$/.test(recent);
  const inherit = latest.length < 18 && userMessages.length > 1 && isReference && !namesNewTopic;
  const query = normalize(inherit ? `${userMessages.at(-2)?.content || ""} ${latest}` : latest).slice(-2500);
  const explicitCategories = ["质量", "设备", "安全", "能源"].filter(category => query.includes(category));
  const grams = new Set<string>();
  for (let i = 0; i < query.length - 1; i++) {
    const pair = query.slice(i, i + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(pair) && !genericPairs.has(pair)) grams.add(pair);
  }
  const ranked = knowledgeEntries.map(entry => {
    const title = normalize(entry.title);
    const keywords = entry.keywords.map(normalize);
    const main = `${title} ${keywords.join(" ")}`;
    const passage = normalize(entry.content);
    let score = query.includes(entry.category) ? 2 : 0;
    let exact = false;
    for (const keyword of keywords) {
      if ((keyword.length >= 2 || keyword === "泵" || keyword === "阀") && query.includes(keyword)) {
        score += 4 + Math.min(keyword.length, 6) * 0.45;
        exact = true;
      }
    }
    let topicHits = 0;
    for (const gram of grams) {
      if (main.includes(gram)) { score += 1.1; topicHits++; }
      else if (passage.includes(gram)) score += 0.15;
    }
    return { entry, score, relevant: exact || query.includes(entry.category) || topicHits >= 2 };
  });
  const candidates = ranked.filter(item => item.relevant && item.score >= 3 &&
    (explicitCategories.length === 0 || explicitCategories.includes(item.entry.category)))
    .sort((a, b) => b.score - a.score);
  const cutoff = (candidates[0]?.score || 0) * 0.7;
  return candidates.filter(item => item.score >= cutoff)
    .slice(0, limit)
    .map(item => item.entry);
}

export function sourcesFor(entries: KnowledgeEntry[]): KnowledgeSource[] {
  const seen = new Set<string>();
  return entries.filter(entry => {
    if (seen.has(entry.sourceUrl)) return false;
    seen.add(entry.sourceUrl);
    return true;
  }).map(entry => ({ title: entry.sourceTitle, url: entry.sourceUrl, publisher: entry.publisher, category: entry.category }));
}
