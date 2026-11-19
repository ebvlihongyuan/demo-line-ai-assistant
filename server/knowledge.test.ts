import { describe, expect, it } from "vitest";
import { knowledgeEntries, retrieveKnowledge, sourcesFor } from "./knowledge";

const ask = (content: string) => [{ role: "user" as const, content }];

describe("chemical knowledge retrieval", () => {
  it("covers all four domains with source links", () => {
    for (const category of ["质量", "设备", "安全", "能源"]) {
      const entries = knowledgeEntries.filter(entry => entry.category === category);
      expect(entries.length).toBeGreaterThanOrEqual(5);
      expect(entries.every(entry => entry.title && entry.content && entry.keywords.length && entry.sourceUrl.startsWith("https://"))).toBe(true);
    }
  });
  it("finds equipment, safety, quality, and energy topics", () => {
    expect(retrieveKnowledge(ask("压力容器维护应关注什么？")).some(entry => entry.title.includes("压力容器"))).toBe(true);
    expect(retrieveKnowledge(ask("受限空间作业有哪些风险？")).some(entry => entry.category === "安全")).toBe(true);
    expect(retrieveKnowledge(ask("化工质量检验如何做好追溯？")).some(entry => entry.category === "质量")).toBe(true);
    expect(retrieveKnowledge(ask("蒸汽系统可以如何节能？")).some(entry => entry.category === "能源")).toBe(true);
  });
  it("retrieves all requested sensor and data acquisition topics", () => {
    const cases = [
      ["电机温度怎么监测？", "sensor-motor-temperature-"],
      ["电机振动异常怎么监测？", "sensor-motor-vibration-"],
      ["环境噪音怎么监测？", "sensor-noise-"],
      ["阀门开关状态如何预警？", "sensor-valve-"],
      ["压力传感器怎么选择？", "sensor-pressure-"],
      ["液位传感器怎么选择？", "sensor-level-"],
      ["传感器数据如何采集？", "sensor-data-acquisition-"],
    ];
    for (const [question, prefix] of cases) {
      expect(retrieveKnowledge(ask(question)).some(entry => entry.id.startsWith(prefix)), question).toBe(true);
    }
    const combined = retrieveKnowledge(ask("压力和液位传感器如何选用？"));
    expect(combined.some(entry => entry.id.startsWith("sensor-pressure-"))).toBe(true);
    expect(combined.some(entry => entry.id.startsWith("sensor-level-"))).toBe(true);
    expect(retrieveKnowledge(ask("厂界环境噪声如何监测？")).some(entry => entry.id === "sensor-noise-boundary-environment")).toBe(true);
  });
  it("filters out unrelated sources when the question identifies a topic", () => {
    expect(retrieveKnowledge(ask("化工质量检验如何做好追溯？")).every(entry => entry.category === "质量")).toBe(true);
    expect(retrieveKnowledge(ask("压力容器维护应关注什么？")).every(entry => entry.title.includes("压力容器"))).toBe(true);
  });
  it("handles single-character equipment and short follow-ups", () => {
    expect(retrieveKnowledge(ask("泵振动怎么处理？")).some(entry => entry.category === "设备")).toBe(true);
    expect(retrieveKnowledge([{ role: "user", content: "压力容器维护有哪些要求？" }, { role: "assistant", content: "请先检查相关规程。" }, { role: "user", content: "那检验呢？" }]).some(entry => entry.title.includes("压力容器"))).toBe(true);
    const changedTopic = retrieveKnowledge([{ role: "user", content: "质量检验如何追溯？" }, { role: "assistant", content: "请保留记录。" }, { role: "user", content: "那蒸汽节能呢？" }]);
    expect(changedTopic.length).toBeGreaterThan(0);
    expect(changedTopic.every(entry => entry.category === "能源")).toBe(true);
  });
  it("does not invent a source for an unrelated greeting and deduplicates sources", () => {
    expect(retrieveKnowledge(ask("你好"))).toEqual([]);
    const entries = retrieveKnowledge(ask("压力容器和设备完整性应如何管理？"));
    const sources = sourcesFor(entries);
    expect(new Set(sources.map(source => source.url)).size).toBe(sources.length);
  });
});
