"use client";

import debounce from "lodash.debounce";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  createLocalNotesApiFallback,
  createNotesApi,
  Note,
  shouldFallbackToLocal,
  Tag,
  type NotesApi,
} from "@/lib/notesApi";
import { ApiError } from "@/lib/apiClient";

type SaveState =
  | { status: "idle" }
  | { status: "saving"; at: string }
  | { status: "saved"; at: string }
  | { status: "error"; at: string; error: unknown };

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function normalizeTags(input: string): string[] {
  const items = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // invariant: unique, lowercased for consistency
  const set = new Set(items.map((t) => t.toLowerCase()));
  return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
}

function errorToMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.kind === "config") return err.message;
    if (err.kind === "http")
      return `${err.message}${err.status ? ` (HTTP ${err.status})` : ""}`;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

export default function Home() {
  /**
   * Important for `output: "export"` builds:
   * - Avoid throwing during prerender. `createNotesApi()` can throw if NEXT_PUBLIC_API_BASE_URL is missing.
   * - We therefore create the backend API lazily at runtime and fall back to local mode when config is missing.
   */
  const apiFallback = useMemo(() => createLocalNotesApiFallback(), []);
  const [api, setApi] = useState<NotesApi>(apiFallback);
  const [mode, setMode] = useState<"backend" | "local">("local");

  const [globalError, setGlobalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [notes, setNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );

  const [draftTitle, setDraftTitle] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [preview, setPreview] = useState(true);

  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });

  // Keep a stable ref to current selected note ID for debounced save.
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const refreshAll = useCallback(
    async (currentApi: NotesApi) => {
      const [notesRes, tagsRes] = await Promise.all([
        currentApi.listNotes({ q: query, tag: activeTag }),
        currentApi.listTags(),
      ]);
      setNotes(notesRes.notes);
      setTags(tagsRes.tags);
      if (notesRes.notes.length > 0 && !selectedIdRef.current) {
        setSelectedId(notesRes.notes[0].id);
      }
    },
    [query, activeTag],
  );

  // initial load with backend attempt + local fallback
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setGlobalError(null);

      // Always start from a known-good mode so static export doesn't fail.
      let backendApi: NotesApi | null = null;
      try {
        backendApi = createNotesApi();
      } catch {
        backendApi = null;
        setApi(apiFallback);
        setMode("local");
        await refreshAll(apiFallback);
        if (!cancelled) setLoading(false);
        return;
      }

      try {
        await backendApi.healthCheck();
        if (cancelled) return;
        setApi(backendApi);
        setMode("backend");
        await refreshAll(backendApi);
      } catch (e) {
        if (cancelled) return;
        if (shouldFallbackToLocal(e)) {
          setApi(apiFallback);
          setMode("local");
          await refreshAll(apiFallback);
        } else {
          setGlobalError(errorToMessage(e));
          // Still show local content to avoid a blank app.
          setApi(apiFallback);
          setMode("local");
          await refreshAll(apiFallback);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiFallback, refreshAll]);

  // refresh list when query/tag changes
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    (async () => {
      try {
        await refreshAll(api);
      } catch (e) {
        if (!cancelled) setGlobalError(errorToMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, activeTag, api, loading, refreshAll]);

  // when selection changes, update draft
  useEffect(() => {
    if (!selected) return;
    setDraftTitle(selected.title);
    setDraftContent(selected.content);
    setDraftTags(selected.tags.join(", "));
    setSaveState({ status: "idle" });
  }, [selected]);

  const createNew = useCallback(async () => {
    setGlobalError(null);
    try {
      const created = await api.createNote();
      // Insert on top and select
      setNotes((prev) => [created, ...prev.filter((n) => n.id !== created.id)]);
      setSelectedId(created.id);
      // Refresh tags (counts)
      const t = await api.listTags();
      setTags(t.tags);
    } catch (e) {
      setGlobalError(errorToMessage(e));
    }
  }, [api]);

  const deleteSelected = useCallback(async () => {
    if (!selected) return;
    const confirmed = window.confirm(`Delete "${selected.title}"?`);
    if (!confirmed) return;

    setGlobalError(null);
    try {
      await api.deleteNote(selected.id);
      setNotes((prev) => prev.filter((n) => n.id !== selected.id));
      setSelectedId((prev) => {
        if (prev !== selected.id) return prev;
        const remaining = notes.filter((n) => n.id !== selected.id);
        return remaining[0]?.id ?? null;
      });
      const t = await api.listTags();
      setTags(t.tags);
    } catch (e) {
      setGlobalError(errorToMessage(e));
    }
  }, [api, notes, selected]);

  const debouncedSave = useMemo(() => {
    const fn = debounce(
      async (payload: Pick<Note, "id" | "title" | "content" | "tags">) => {
        const at = new Date().toISOString();
        setSaveState({ status: "saving", at });
        try {
          const updated = await api.updateNote(payload);
          setNotes((prev) =>
            prev
              .map((n) => (n.id === updated.id ? updated : n))
              .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
          );
          setSaveState({ status: "saved", at: new Date().toISOString() });
          const t = await api.listTags();
          setTags(t.tags);
        } catch (e) {
          setSaveState({ status: "error", at, error: e });
        }
      },
      650,
    );
    return fn;
  }, [api]);

  // trigger autosave when draft changes
  useEffect(() => {
    if (!selected) return;

    const payload = {
      id: selected.id,
      title: draftTitle.trim() || "Untitled note",
      content: draftContent,
      tags: normalizeTags(draftTags),
    };

    // Optimistically update list title/tags for better UX; backend response will reconcile.
    setNotes((prev) =>
      prev.map((n) =>
        n.id === selected.id
          ? {
              ...n,
              title: payload.title,
              content: payload.content,
              tags: payload.tags,
              updatedAt: new Date().toISOString(),
            }
          : n,
      ),
    );

    debouncedSave(payload);
    return () => {
      // no-op: we intentionally allow in-flight autosave to complete
    };
  }, [draftTitle, draftContent, draftTags, selected, debouncedSave]);

  const statusText = useMemo(() => {
    if (mode === "local")
      return "Local mode (backend not configured / endpoints missing)";
    return "Connected to backend";
  }, [mode]);

  const saveText = useMemo(() => {
    if (!selected) return "";
    if (saveState.status === "idle") return "";
    if (saveState.status === "saving")
      return `Saving… (${formatTime(saveState.at)})`;
    if (saveState.status === "saved")
      return `Saved (${formatTime(saveState.at)})`;
    return `Save failed: ${errorToMessage(saveState.error)}`;
  }, [saveState, selected]);

  if (loading) {
    return (
      <main className="nm-app">
        <header className="nm-card" style={{ margin: 12, padding: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontWeight: 700 }}>NoteMaster</div>
              <div style={{ fontSize: 13, color: "var(--nm-muted)" }}>
                Loading…
              </div>
            </div>
            <div className="nm-badge">Preparing workspace</div>
          </div>
        </header>
        <section className="nm-card" style={{ margin: 12, padding: 16 }}>
          <p style={{ color: "var(--nm-muted)" }}>
            Connecting to API and loading notes…
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="nm-app">
      {/* Top bar */}
      <header className="nm-card" style={{ margin: 12, padding: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontWeight: 800, letterSpacing: "-0.02em" }}>
              NoteMaster
            </div>
            <div style={{ fontSize: 13, color: "var(--nm-muted)" }}>
              {statusText}
              {saveText ? ` • ${saveText}` : ""}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="nm-kbd">Ctrl</span>
              <span className="nm-kbd">K</span>
              <span style={{ fontSize: 13, color: "var(--nm-muted)" }}>
                Search
              </span>
            </div>

            <button className="nm-btn nm-btn--primary" onClick={createNew}>
              New note
            </button>
            <button
              className="nm-btn nm-btn--danger"
              onClick={deleteSelected}
              disabled={!selected}
            >
              Delete
            </button>
          </div>
        </div>

        {globalError ? (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              border: "1px solid rgba(239, 68, 68, 0.35)",
              background: "rgba(239, 68, 68, 0.06)",
              color: "var(--nm-danger)",
              fontSize: 14,
            }}
          >
            {globalError}
          </div>
        ) : null}
      </header>

      {/* 3-column shell */}
      <div className="nm-shell">
        {/* Sidebar */}
        <aside
          className="nm-card"
          style={{
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "var(--nm-muted)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Tags
          </div>

          <button
            className="nm-btn"
            style={{
              justifyContent: "space-between",
              borderColor:
                activeTag === null
                  ? "rgba(6, 182, 212, 0.45)"
                  : "var(--nm-border)",
              background:
                activeTag === null
                  ? "rgba(6, 182, 212, 0.10)"
                  : "var(--nm-surface)",
            }}
            onClick={() => setActiveTag(null)}
          >
            <span>All notes</span>
            <span className="nm-badge">{notes.length}</span>
          </button>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {tags.length === 0 ? (
              <span style={{ color: "var(--nm-muted)", fontSize: 14 }}>
                No tags yet
              </span>
            ) : (
              tags.map((t) => (
                <button
                  key={t.name}
                  className={`nm-badge ${
                    activeTag === t.name ? "nm-badge--active" : ""
                  }`}
                  style={{ cursor: "pointer" }}
                  onClick={() =>
                    setActiveTag((prev) => (prev === t.name ? null : t.name))
                  }
                  title={`${t.count} note(s)`}
                >
                  #{t.name} · {t.count}
                </button>
              ))
            )}
          </div>

          <div style={{ marginTop: "auto", fontSize: 12, color: "var(--nm-muted)" }}>
            <div style={{ marginBottom: 6, fontWeight: 700 }}>API</div>
            <div style={{ lineHeight: 1.5 }}>
              Base URL:{" "}
              <code style={{ fontSize: 12 }}>
                {process.env.NEXT_PUBLIC_API_BASE_URL || "(not set)"}
              </code>
            </div>
          </div>
        </aside>

        {/* Note list */}
        <section
          className="nm-card nm-shell__list"
          style={{
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="nm-input"
              placeholder="Search notes… (title, content, tags)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).focus();
                }
              }}
            />
          </div>

          <div
            style={{
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {notes.length === 0 ? (
              <div style={{ padding: 12, color: "var(--nm-muted)" }}>
                No notes found.
              </div>
            ) : (
              notes.map((n) => {
                const isActive = n.id === selectedId;
                return (
                  <button
                    key={n.id}
                    className="nm-btn"
                    onClick={() => setSelectedId(n.id)}
                    style={{
                      textAlign: "left",
                      alignItems: "flex-start",
                      flexDirection: "column",
                      gap: 6,
                      padding: 12,
                      borderColor: isActive
                        ? "rgba(59, 130, 246, 0.55)"
                        : "var(--nm-border)",
                      background: isActive
                        ? "rgba(59, 130, 246, 0.08)"
                        : "var(--nm-surface)",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 700,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 220,
                        }}
                      >
                        {n.title || "Untitled note"}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--nm-muted)",
                          flexShrink: 0,
                        }}
                      >
                        {formatTime(n.updatedAt)}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--nm-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {n.content || "No content"}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {n.tags.slice(0, 4).map((t) => (
                        <span key={t} className="nm-badge">
                          #{t}
                        </span>
                      ))}
                      {n.tags.length > 4 ? (
                        <span className="nm-badge">+{n.tags.length - 4}</span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Editor */}
        <section
          className="nm-card nm-shell__editor"
          style={{
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {!selected ? (
            <div style={{ padding: 12, color: "var(--nm-muted)" }}>
              Select a note to start editing, or create a new one.
            </div>
          ) : (
            <>
              <div
                style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}
              >
                <input
                  className="nm-input"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Note title"
                  aria-label="Note title"
                />

                <input
                  className="nm-input"
                  value={draftTags}
                  onChange={(e) => setDraftTags(e.target.value)}
                  placeholder="Tags (comma-separated) e.g. work, ideas, todo"
                  aria-label="Tags"
                />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 13, color: "var(--nm-muted)" }}>
                  Markdown supported (GFM).
                </div>
                <button className="nm-btn" onClick={() => setPreview((p) => !p)}>
                  {preview ? "Hide preview" : "Show preview"}
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: preview ? "1fr 1fr" : "1fr",
                  gap: 12,
                  minHeight: 420,
                }}
              >
                <textarea
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  placeholder="Write in Markdown…"
                  style={{
                    width: "100%",
                    minHeight: 420,
                    borderRadius: 12,
                    border: "1px solid var(--nm-border)",
                    padding: 12,
                    fontSize: 14,
                    resize: "vertical",
                    outline: "none",
                    background: "var(--nm-surface)",
                    color: "var(--nm-text)",
                    lineHeight: 1.5,
                  }}
                  aria-label="Markdown editor"
                />
                {preview ? (
                  <div
                    style={{
                      borderRadius: 12,
                      border: "1px solid var(--nm-border)",
                      padding: 12,
                      overflow: "auto",
                      background: "rgba(59, 130, 246, 0.03)",
                    }}
                    aria-label="Markdown preview"
                  >
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--nm-muted)",
                        marginBottom: 10,
                      }}
                    >
                      Preview
                    </div>
                    <article style={{ lineHeight: 1.6 }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {draftContent || "_Nothing to preview yet._"}
                      </ReactMarkdown>
                    </article>
                  </div>
                ) : null}
              </div>

              {saveState.status === "error" ? (
                <div
                  role="alert"
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: "1px solid rgba(239, 68, 68, 0.35)",
                    background: "rgba(239, 68, 68, 0.06)",
                    color: "var(--nm-danger)",
                    fontSize: 14,
                  }}
                >
                  Autosave error: {errorToMessage(saveState.error)}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
