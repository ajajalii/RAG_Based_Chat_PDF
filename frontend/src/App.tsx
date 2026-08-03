import { useCallback, useRef, useState } from "react";
import {
  analyzeDocument,
  chatDocument,
  deleteDocument,
  uploadPdf,
  type Citation,
} from "./api";
import { EmptyState } from "./components/EmptyState";
import { PdfViewer } from "./components/PdfViewer";
import { SectionTitle } from "./components/SectionTitle";
import {
  IconBook,
  IconChat,
  IconClose,
  IconDocChat,
  IconFile,
  IconMoon,
  IconSend,
  IconSparkle,
  IconSun,
  IconUpload,
} from "./components/icons";
import { cn, ui, type Theme } from "./theme-classes";

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains("light") ? "light" : "dark"
  );
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [sizeBytes, setSizeBytes] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [summary, setSummary] = useState<string[]>([]);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(next);
    localStorage.setItem("theme", next);
  };

  const resetDoc = useCallback(async () => {
    if (documentId) {
      try {
        await deleteDocument(documentId);
      } catch {
        /* ignore */
      }
    }
    setDocumentId(null);
    setFilename("");
    setSizeBytes(0);
    setPageNumber(1);
    setSummary([]);
    setSuggested([]);
    setMessages([]);
    setInput("");
    setError(null);
  }, [documentId]);

  const onPickFile = () => fileInputRef.current?.click();

  const onFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      if (documentId) {
        await deleteDocument(documentId);
      }
      const res = await uploadPdf(file);
      setDocumentId(res.document_id);
      setFilename(res.filename);
      setSizeBytes(res.size_bytes);
      setPageNumber(1);
      setSummary([]);
      setSuggested([]);
      setMessages([]);
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f?.name.toLowerCase().endsWith(".pdf")) void onFile(f);
  };

  const runAnalyze = async () => {
    if (!documentId) return;
    setError(null);
    setAnalyzing(true);
    try {
      const r = await analyzeDocument(documentId);
      setSummary(r.summary);
      setSuggested(r.suggested_questions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const sendMessage = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!documentId || !msg || chatting) return;
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: msg }]);
    setChatting(true);
    try {
      const r = await chatDocument(documentId, msg);
      setMessages((m) => [
        ...m,
        { role: "assistant", content: r.answer, citations: r.citations },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: e instanceof Error ? e.message : "Chat request failed.",
        },
      ]);
    } finally {
      setChatting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  return (
    <div className={ui.app(theme)}>
      <header className={ui.header(theme)}>
        <div className={ui.brand(theme)}>
          <span className={ui.brandIcon(theme)}>
            <IconDocChat className="h-7 w-7" />
          </span>
          <span className="text-[15px] sm:text-base">ChatPDF Pro AI</span>
        </div>
        <button type="button" onClick={toggleTheme} className={ui.btnThemeToggle(theme)}>
          {theme === "dark" ? (
            <>
              <IconSun className="h-3.5 w-3.5" /> Light
            </>
          ) : (
            <>
              <IconMoon className="h-3.5 w-3.5" /> Dark
            </>
          )}
        </button>
      </header>

      <main className="mx-auto flex w-full max-w-[1580px] flex-1 flex-col gap-4 px-4 py-4 lg:h-[calc(100dvh-3.5rem)] lg:flex-row lg:gap-5 lg:px-6 lg:py-5">
        {/* PDF column */}
        <section className={cn(ui.panel(theme), "min-h-[400px] flex-1 lg:min-h-0")}>
          <div className={cn(ui.panelBody, "flex min-h-0 flex-1 flex-col")}>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />

            {!documentId ? (
              <>
                <button
                  type="button"
                  onClick={onPickFile}
                  disabled={uploading}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDrop}
                  className={ui.uploadZone(theme)}
                >
                  <IconUpload
                    className={cn("h-10 w-10", theme === "dark" ? "text-zinc-500" : "text-zinc-400")}
                  />
                  <span className="text-sm font-medium">
                    {uploading ? "Uploading…" : "Drop PDF here or click to browse"}
                  </span>
                  <span className={cn("text-xs", ui.muted(theme))}>PDF files only</span>
                </button>
                <div className={ui.emptyWell(theme)}>
                  <EmptyState
                    theme={theme}
                    icon={<IconBook className="h-11 w-11" />}
                    title="No document loaded"
                    description="Upload a PDF above to view and analyze it."
                  />
                </div>
              </>
            ) : (
              <>
                <div className={ui.toolbar(theme)}>
                  <IconFile className={cn("h-5 w-5 shrink-0", ui.accentIcon(theme))} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{filename}</p>
                    <p className={cn("text-xs", ui.muted(theme))}>{formatBytes(sizeBytes)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void resetDoc()}
                    className={ui.btnIcon(theme)}
                    title="Remove document"
                    aria-label="Remove document"
                  >
                    <IconClose className="h-5 w-5" />
                  </button>
                </div>
                <PdfViewer
                  documentId={documentId}
                  pageNumber={pageNumber}
                  onPageChange={setPageNumber}
                  theme={theme}
                />
              </>
            )}
          </div>
        </section>

        {/* Sidebar */}
        <aside className="flex w-full min-h-0 flex-col gap-4 lg:w-[420px] lg:max-w-[min(420px,100%)] lg:shrink-0">
          <section className={cn(ui.panel(theme), "min-h-0 shrink-0 lg:max-h-[42%]")}>
            <div className={cn(ui.panelBody, "min-h-0")}>
              <SectionTitle theme={theme} icon={<IconSparkle className="h-4 w-4" />}>
                Document summary
              </SectionTitle>
              {summary.length === 0 ? (
                <div className="flex flex-col gap-4">
                  <p className={cn("text-sm leading-relaxed", ui.muted(theme))}>
                    Generate a concise summary and suggested questions from your PDF.
                  </p>
                  <button
                    type="button"
                    disabled={!documentId || analyzing}
                    onClick={() => void runAnalyze()}
                    className={ui.btnPrimary(theme)}
                  >
                    <IconSparkle className="h-4 w-4" />
                    {analyzing ? "Analyzing…" : "Analyze document"}
                  </button>
                </div>
              ) : (
                <div className="flex min-h-0 max-h-[min(40vh,320px)] flex-col gap-4">
                  <ul
                    className={cn(
                      "list-disc space-y-2.5 overflow-y-auto pl-5 text-sm leading-relaxed",
                      theme === "dark" ? "text-zinc-200" : "text-zinc-800"
                    )}
                  >
                    {summary.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={!documentId || analyzing}
                    onClick={() => void runAnalyze()}
                    className={ui.btnSecondary(theme)}
                  >
                    {analyzing ? "Re-analyzing…" : "Re-analyze"}
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className={cn(ui.panel(theme), "min-h-[340px] flex-1 lg:min-h-0")}>
            <div className={cn(ui.panelBody, "flex min-h-0 flex-1 flex-col")}>
              <SectionTitle theme={theme} icon={<IconChat className="h-4 w-4" />}>
                Chat
              </SectionTitle>

              <div className={cn(ui.inset(theme), "min-h-0 flex-1 overflow-hidden")}>
                <div className="h-full min-h-[180px] overflow-y-auto p-3 sm:p-4">
                  {!documentId ? (
                    <EmptyState
                      theme={theme}
                      icon={<IconChat className="h-11 w-11" />}
                      title="Upload a PDF to start"
                      description="Use the upload area on the left, then ask questions with page citations."
                    />
                  ) : messages.length === 0 ? (
                    <EmptyState
                      theme={theme}
                      icon={<IconChat className="h-11 w-11" />}
                      title="Ask about this document"
                      description="Answers use retrieved text from your PDF. Citation chips jump to the right page."
                    />
                  ) : (
                    <div className="flex flex-col gap-3">
                      {messages.map((m, idx) => (
                        <div
                          key={idx}
                          className={
                            m.role === "user"
                              ? ui.bubbleUser(theme)
                              : ui.bubbleAssistant(theme)
                          }
                        >
                          <p className="whitespace-pre-wrap">{m.content}</p>
                          {m.citations && m.citations.length > 0 && (
                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                              {m.citations.map((c, j) => (
                                <button
                                  key={j}
                                  type="button"
                                  onClick={() => setPageNumber(c.page)}
                                  className={ui.chip(theme)}
                                >
                                  p. {c.page}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      {chatting ? (
                        <p className={cn("text-sm italic", ui.muted(theme))}>Thinking…</p>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>

              {documentId && suggested.length > 0 ? (
                <div>
                  <p className={ui.chipGroupLabel}>Suggested questions</p>
                  <div className="flex flex-wrap gap-2">
                    {suggested.map((q, i) => (
                      <button
                        key={i}
                        type="button"
                        disabled={chatting}
                        onClick={() => void sendMessage(q)}
                        className={ui.suggestion(theme)}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="relative mt-auto pt-1">
                <textarea
                  rows={2}
                  disabled={!documentId || chatting}
                  placeholder={
                    documentId ? "Ask a question about the document…" : "Upload a PDF first…"
                  }
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  className={ui.textarea(theme)}
                />
                <button
                  type="button"
                  disabled={!documentId || chatting || !input.trim()}
                  onClick={() => void sendMessage()}
                  className={ui.sendFab(theme)}
                  title="Send"
                  aria-label="Send message"
                >
                  <IconSend className="h-4 w-4" />
                </button>
                <p className={cn("mt-2 text-center text-[11px]", ui.muted(theme))}>
                  <span className="font-medium text-zinc-600 dark:text-zinc-400">Enter</span> to send ·{" "}
                  <span className="font-medium text-zinc-600 dark:text-zinc-400">Shift+Enter</span> new line
                </p>
              </div>
            </div>
          </section>
        </aside>
      </main>

      {error ? <div className={ui.errorToast(theme)}>{error}</div> : null}
    </div>
  );
}
