import { useId, useRef, useState, type ChangeEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  FolderOpen,
  HardDrive,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import "./local-knowledge.css";

const TARGET_DIRECTORY = "D:\\示范线知识库";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SUPPORTED_EXTENSION = /\.(docx|pdf|xlsx)$/i;

interface LocalDocument {
  id: string;
  name: string;
  importedAt: string;
  status: "indexed" | "empty";
  segmentCount: number;
  warning?: string;
}

type ImportState = "queued" | "processing" | "success" | "failed";
interface ImportResult {
  key: number;
  name: string;
  state: ImportState;
  detail?: string;
}

interface LocalKnowledgePanelProps {
  open: boolean;
  onClose: () => void;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizeDirectory(directory: string) {
  return directory
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("无法读取文件，请重新选择后重试。"));
    reader.onabort = () => reject(new Error("文件读取已中断，请重试。"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("文件读取结果无效，请重试。"));
        return;
      }
      const comma = reader.result.indexOf(",");
      if (comma < 0) {
        reject(new Error("文件编码失败，请重试。"));
        return;
      }
      resolve(reader.result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function LocalKnowledgePanel({
  open,
  onClose,
}: LocalKnowledgePanelProps) {
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const nextResultKey = useRef(0);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState("");

  // These procedures are supplied by the local-knowledge backend router.
  const statusQuery = trpc.localKnowledge.status.useQuery(undefined, {
    enabled: open,
    retry: false,
  });
  const directoryMatches =
    typeof statusQuery.data?.directory === "string" &&
    normalizeDirectory(statusQuery.data.directory) ===
      normalizeDirectory(TARGET_DIRECTORY);
  const canManage = Boolean(
    open &&
      !statusQuery.isFetching &&
      !statusQuery.isError &&
      statusQuery.data?.available &&
      directoryMatches
  );
  const listQuery = trpc.localKnowledge.list.useQuery(undefined, {
    enabled: canManage,
    retry: false,
  });
  const importMutation = trpc.localKnowledge.import.useMutation();
  const removeMutation = trpc.localKnowledge.remove.useMutation();

  const updateResult = (key: number, update: Partial<ImportResult>) => {
    setResults(previous =>
      previous.map(result =>
        result.key === key ? { ...result, ...update } : result
      )
    );
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    // Reset so that choosing the same file after a failure fires onChange again.
    event.currentTarget.value = "";
    if (!files.length || importingRef.current || !canManage) return;

    importingRef.current = true;
    setImporting(true);
    setOperationError("");
    const queue = files.map(file => ({ file, key: ++nextResultKey.current }));
    setResults(
      queue.map(({ file, key }) => ({ key, name: file.name, state: "queued" }))
    );

    try {
      for (const { file, key } of queue) {
        if (!SUPPORTED_EXTENSION.test(file.name)) {
          updateResult(key, {
            state: "failed",
            detail: "仅支持 .docx、.pdf 和 .xlsx；旧版 .doc、.xls 请先转换。",
          });
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          updateResult(key, {
            state: "failed",
            detail: "文件超过单个 10 MiB 的限制。",
          });
          continue;
        }

        updateResult(key, { state: "processing", detail: "正在读取并导入…" });
        try {
          const dataBase64 = await readBase64(file);
          const document: LocalDocument = await importMutation.mutateAsync({
            name: file.name,
            dataBase64,
          });
          updateResult(key, {
            state: "success",
            detail:
              document.warning ||
              (document.status === "empty"
                ? "已导入，但未提取到可索引文字。"
                : `已建立索引，共 ${document.segmentCount} 个片段。`),
          });
          // Refresh after each success so completed files are visible during a longer queue.
          // A refresh failure is reported by the list query and must not turn a successful import into a failure.
          await listQuery.refetch().catch(() => undefined);
        } catch (error) {
          updateResult(key, {
            state: "failed",
            detail: errorText(error, "导入失败，请稍后重试。"),
          });
        }
      }
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const handleRemove = async (document: LocalDocument) => {
    if (!canManage || importingRef.current || removingId) return;
    const confirmed = window.confirm(
      `确定从本机知识库中删除“${document.name}”吗？\n\n仅删除知识库副本和索引，不会删除您选择的原始文件。`
    );
    if (!confirmed) return;

    setOperationError("");
    setRemovingId(document.id);
    try {
      await removeMutation.mutateAsync({ id: document.id });
      await listQuery.refetch().catch(() => undefined);
    } catch (error) {
      setOperationError(errorText(error, "删除失败，请稍后重试。"));
    } finally {
      setRemovingId(null);
    }
  };

  const isChecking = statusQuery.isFetching || (open && statusQuery.isPending);
  const unavailable =
    !isChecking &&
    !statusQuery.isError &&
    statusQuery.data?.available === false;
  const wrongDirectory =
    !isChecking &&
    !statusQuery.isError &&
    statusQuery.data?.available &&
    !directoryMatches;
  const documents: LocalDocument[] = listQuery.data ?? [];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="lkp-overlay" />
        <Dialog.Content className="lkp-dialog">
          <header className="lkp-header">
            <span className="lkp-header-icon" aria-hidden="true">
              <FolderOpen size={22} />
            </span>
            <div className="lkp-header-copy">
              <span className="lkp-kicker">LOCAL KNOWLEDGE</span>
              <Dialog.Title className="lkp-title">本机知识库</Dialog.Title>
              <Dialog.Description className="lkp-subtitle">
                管理手动添加的文档，让资料更容易查找。
              </Dialog.Description>
            </div>
            <Dialog.Close className="lkp-close" aria-label="关闭本机知识库面板">
              <X size={19} />
            </Dialog.Close>
          </header>

          <div className="lkp-body">
            <div className="lkp-location">
              <span className="lkp-location-icon" aria-hidden="true">
                <HardDrive size={18} />
              </span>
              <div className="lkp-location-copy">
                <span>目标文件夹</span>
                <code>{TARGET_DIRECTORY}</code>
              </div>
              <span
                className={`lkp-status ${canManage ? "lkp-status-ready" : "lkp-status-muted"}`}
              >
                <i aria-hidden="true" />
                {isChecking
                  ? "检查中"
                  : statusQuery.isError
                    ? "状态未知"
                    : canManage
                      ? "可用"
                      : "不可用"}
              </span>
            </div>

            {isChecking && (
              <div className="lkp-notice lkp-notice-info" role="status">
                <LoaderCircle
                  className="lkp-spin"
                  size={17}
                  aria-hidden="true"
                />
                <span>正在检查本机知识库服务…</span>
              </div>
            )}
            {!isChecking && statusQuery.isError && (
              <div className="lkp-notice lkp-notice-warning" role="alert">
                <AlertCircle size={17} aria-hidden="true" />
                <div>
                  <strong>无法确认本机服务状态</strong>
                  <p>
                    {errorText(
                      statusQuery.error,
                      "请检查本机服务是否已启动，然后重试。"
                    )}
                  </p>
                  <button
                    type="button"
                    className="lkp-text-button"
                    onClick={() => void statusQuery.refetch()}
                  >
                    <RefreshCw size={13} />
                    重新检查
                  </button>
                </div>
              </div>
            )}
            {unavailable && (
              <div className="lkp-notice lkp-notice-warning" role="status">
                <Info size={17} aria-hidden="true" />
                <div>
                  <strong>当前环境不可用</strong>
                  <p>
                    {statusQuery.data?.reason ||
                      "当前环境暂不能使用本机知识库，请确认使用受支持的 Windows 本机服务并检查磁盘。"}
                  </p>
                  <p>此页面不会声称可以访问其他设备的 Windows 硬盘。</p>
                  <button
                    type="button"
                    className="lkp-text-button"
                    onClick={() => void statusQuery.refetch()}
                  >
                    <RefreshCw size={13} />
                    重新检查
                  </button>
                </div>
              </div>
            )}
            {wrongDirectory && (
              <div className="lkp-notice lkp-notice-warning" role="alert">
                <AlertCircle size={17} aria-hidden="true" />
                <div>
                  <strong>服务返回的路径与目标路径不一致</strong>
                  <p>
                    服务返回：{statusQuery.data?.directory || "（空）"}
                    。为避免操作错误的文件夹，已暂停导入和删除，请联系管理员检查配置。
                  </p>
                  <button
                    type="button"
                    className="lkp-text-button"
                    onClick={() => void statusQuery.refetch()}
                  >
                    <RefreshCw size={13} />
                    重新检查
                  </button>
                </div>
              </div>
            )}

            <section className="lkp-section" aria-labelledby="lkp-import-title">
              <div className="lkp-section-heading">
                <div>
                  <span className="lkp-section-number">01 / 添加资料</span>
                  <h2 id="lkp-import-title">导入文档</h2>
                </div>
              </div>
              <div className="lkp-upload-box">
                <div className="lkp-upload-copy">
                  <span className="lkp-upload-icon" aria-hidden="true">
                    <Upload size={19} />
                  </span>
                  <div>
                    <strong>选择需要添加的文件</strong>
                    <p>支持 .docx、.pdf、.xlsx，可多选并逐个处理</p>
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  id={fileInputId}
                  className="lkp-file-input"
                  type="file"
                  accept=".docx,.pdf,.xlsx"
                  multiple
                  onChange={handleFiles}
                  disabled={!canManage || importing || Boolean(removingId)}
                  aria-label="选择要导入的文档"
                />
                <button
                  type="button"
                  className="lkp-primary-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!canManage || importing || Boolean(removingId)}
                  aria-describedby="lkp-file-hint"
                >
                  {importing ? (
                    <>
                      <LoaderCircle
                        className="lkp-spin"
                        size={15}
                        aria-hidden="true"
                      />
                      处理中
                    </>
                  ) : (
                    <>
                      <Upload size={15} aria-hidden="true" />
                      选择文件
                    </>
                  )}
                </button>
              </div>
              <p className="lkp-hint" id="lkp-file-hint">
                每个文件不超过 10 MiB；仅处理您手动选择的文件，不扫描其他磁盘。
              </p>

              {results.length > 0 && (
                <div
                  className="lkp-results"
                  aria-live="polite"
                  aria-atomic="false"
                  aria-label="导入处理结果"
                >
                  {results.map(result => (
                    <div className="lkp-result" key={result.key}>
                      <span
                        className={`lkp-result-icon lkp-result-${result.state}`}
                        aria-hidden="true"
                      >
                        {result.state === "processing" ? (
                          <LoaderCircle className="lkp-spin" size={16} />
                        ) : result.state === "success" ? (
                          <CheckCircle2 size={16} />
                        ) : result.state === "failed" ? (
                          <AlertCircle size={16} />
                        ) : (
                          <FileText size={16} />
                        )}
                      </span>
                      <div className="lkp-result-copy">
                        <strong title={result.name}>{result.name}</strong>
                        <span>{result.detail || "等待处理"}</span>
                      </div>
                      <span
                        className={`lkp-result-label lkp-result-${result.state}`}
                      >
                        {result.state === "queued"
                          ? "等待中"
                          : result.state === "processing"
                            ? "处理中"
                            : result.state === "success"
                              ? "成功"
                              : "失败"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section
              className="lkp-section lkp-documents"
              aria-labelledby="lkp-list-title"
            >
              <div className="lkp-section-heading">
                <div>
                  <span className="lkp-section-number">02 / 已添加资料</span>
                  <h2 id="lkp-list-title">知识库文档</h2>
                </div>
                {canManage && !listQuery.isError && !listQuery.isPending && (
                  <span className="lkp-count">{documents.length} 个文件</span>
                )}
              </div>
              {operationError && (
                <div className="lkp-inline-error" role="alert">
                  <AlertCircle size={15} aria-hidden="true" />
                  {operationError}
                </div>
              )}
              {!canManage ? (
                <div className="lkp-empty">
                  <FolderOpen size={21} aria-hidden="true" />
                  <p>本机服务可用后，可在这里查看和管理文档。</p>
                </div>
              ) : listQuery.isPending ? (
                <div className="lkp-empty" role="status">
                  <LoaderCircle
                    className="lkp-spin"
                    size={21}
                    aria-hidden="true"
                  />
                  <p>正在读取文档列表…</p>
                </div>
              ) : listQuery.isError ? (
                <div className="lkp-empty lkp-empty-error" role="alert">
                  <AlertCircle size={21} aria-hidden="true" />
                  <p>
                    无法读取文档列表：
                    {errorText(listQuery.error, "请稍后重试。")}
                  </p>
                  <button
                    type="button"
                    className="lkp-text-button"
                    onClick={() => void listQuery.refetch()}
                  >
                    <RefreshCw size={13} />
                    重试
                  </button>
                </div>
              ) : documents.length === 0 ? (
                <div className="lkp-empty">
                  <FolderOpen size={21} aria-hidden="true" />
                  <p>还没有添加文档，选择文件后将在这里显示。</p>
                </div>
              ) : (
                <ul className="lkp-file-list">
                  {documents.map(document => (
                    <li className="lkp-file" key={document.id}>
                      <span className="lkp-file-icon" aria-hidden="true">
                        <FileText size={18} />
                      </span>
                      <div className="lkp-file-copy">
                        <strong title={document.name}>{document.name}</strong>
                        <span>
                          {document.status === "indexed"
                            ? `已索引 · ${document.segmentCount} 个片段`
                            : "未提取到可索引文字"}{" "}
                          <b>·</b> {formatDate(document.importedAt)}
                        </span>
                        <span>标识：{document.id}</span>
                        {document.warning && (
                          <span className="lkp-file-warning">
                            {document.warning}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="lkp-delete"
                        aria-label={`删除 ${document.name} 的知识库副本和索引`}
                        title="删除知识库副本和索引"
                        onClick={() => void handleRemove(document)}
                        disabled={importing || Boolean(removingId)}
                      >
                        {removingId === document.id ? (
                          <LoaderCircle
                            className="lkp-spin"
                            size={16}
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 size={16} aria-hidden="true" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <aside className="lkp-privacy" aria-label="使用与隐私说明">
              <ShieldCheck size={19} aria-hidden="true" />
              <div>
                <strong>使用前请了解</strong>
                <ul>
                  <li>
                    只处理手动选择的文件，不扫描其他磁盘。扫描版 PDF
                    没有文字时暂不支持 OCR。
                  </li>
                  <li>旧版 .doc、.xls 文件需先转换为 .docx、.xlsx。</li>
                  <li>
                    文件和内容不发送外部模型；导入时会发送给当前应用服务处理，请确认服务运行在受信任的本机环境。
                  </li>
                  <li>
                    共享设备上的其他本地用户可能访问知识库副本，请注意访问权限。
                  </li>
                </ul>
              </div>
            </aside>
          </div>
          <footer className="lkp-footer">
            <span>资料由您选择，管理由您掌握</span>
            <Dialog.Close className="lkp-secondary-button">完成</Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
