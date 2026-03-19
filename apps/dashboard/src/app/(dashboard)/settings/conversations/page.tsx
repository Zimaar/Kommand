'use client';

import { useEffect, useState, useCallback } from 'react';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls: ToolCall[] | null;
  toolResults: unknown;
  tokensUsed: number | null;
  latencyMs: number | null;
  createdAt: string;
  conversationId: string;
}

interface ToolCall {
  name?: string;
  function?: { name?: string };
  input?: unknown;
  arguments?: unknown;
}

interface ConversationsResponse {
  messages: Message[];
  total: number;
  hasMore: boolean;
  error?: string;
}

interface SearchResponse {
  messages: Message[];
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day:   'numeric',
    hour:  '2-digit',
    minute: '2-digit',
  });
}

// ─── ToolCallSection ──────────────────────────────────────────────────────────

function ToolCallSection({
  toolCalls,
  toolResults,
}: {
  toolCalls: ToolCall[];
  toolResults: unknown;
}) {
  const [expanded, setExpanded] = useState(false);

  const name =
    toolCalls[0]?.name ??
    toolCalls[0]?.function?.name ??
    'tool';

  const input  = toolCalls[0]?.input ?? toolCalls[0]?.arguments;

  return (
    <div className="mt-2 text-xs rounded-lg overflow-hidden border border-white/20">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-black/10 hover:bg-black/20 text-left transition-colors"
      >
        <span>📊</span>
        <span className="font-mono flex-1 truncate">Called {name}</span>
        <span className="opacity-60 text-[10px]">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-3 py-2 space-y-2 font-mono bg-black/10">
          {input !== undefined && (
            <div>
              <p className="opacity-50 mb-0.5 text-[10px] uppercase tracking-wide">Input</p>
              <pre className="whitespace-pre-wrap break-all text-[11px] opacity-80">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {toolResults !== null && toolResults !== undefined && (
            <div>
              <p className="opacity-50 mb-0.5 text-[10px] uppercase tracking-wide">Output</p>
              <pre className="whitespace-pre-wrap break-all text-[11px] opacity-80">
                {JSON.stringify(toolResults, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  const isOwner = msg.direction === 'inbound';

  return (
    <div className={`flex ${isOwner ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[75%] flex flex-col ${isOwner ? 'items-end' : 'items-start'}`}>
        <div
          className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
            isOwner
              ? 'bg-blue-500 text-white rounded-br-sm'
              : 'bg-gray-100 text-gray-800 rounded-bl-sm'
          }`}
        >
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>

          {Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0 && (
            <ToolCallSection toolCalls={msg.toolCalls} toolResults={msg.toolResults} />
          )}
        </div>

        <span className="text-[11px] text-gray-400 mt-1 px-1 select-none">
          {formatTime(msg.createdAt)}
          {msg.latencyMs !== null && !isOwner && (
            <span className="ml-1 opacity-60">· {msg.latencyMs}ms</span>
          )}
        </span>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const LIMIT = 50;

export default function ConversationsPage() {
  const [messages,    setMessages]    = useState<Message[]>([]);
  const [total,       setTotal]       = useState(0);
  const [offset,      setOffset]      = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching,   setSearching]   = useState(false);
  const [isSearch,    setIsSearch]    = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // ── Fetch paginated messages ───────────────────────────────────────────────

  const fetchMessages = useCallback(async (newOffset: number) => {
    if (newOffset === 0) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    try {
      const res  = await fetch(`/api/conversations?limit=${LIMIT}&offset=${newOffset}`);
      const data = await res.json() as ConversationsResponse;

      if (!res.ok) { setError(data.error ?? 'Failed to load conversations'); return; }

      setMessages(prev => newOffset === 0 ? data.messages : [...prev, ...data.messages]);
      setTotal(data.total);
      setOffset(newOffset + data.messages.length);
    } catch {
      setError('Failed to load conversations');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { void fetchMessages(0); }, [fetchMessages]);

  // ── Debounced search ───────────────────────────────────────────────────────

  useEffect(() => {
    const trimmed = searchQuery.trim();

    if (!trimmed) {
      if (isSearch) {
        setIsSearch(false);
        void fetchMessages(0);
      }
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      setIsSearch(true);
      setError(null);
      try {
        const res  = await fetch(`/api/conversations/search?q=${encodeURIComponent(trimmed)}`);
        const data = await res.json() as SearchResponse;
        if (res.ok) setMessages(data.messages);
        else setError(data.error ?? 'Search failed');
      } catch {
        setError('Search failed');
      } finally {
        setSearching(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const hasMore = !isSearch && messages.length < total;

  // Display in chronological order (reverse of desc fetch)
  const displayed = [...messages].reverse();

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 7rem)' }}>
      {/* Header */}
      <div className="mb-4 flex-shrink-0">
        <h1 className="text-xl font-semibold text-gray-900">Conversation Log</h1>
        <p className="text-sm text-gray-500 mt-0.5">Your message history with Kommand</p>
      </div>

      {/* Search bar */}
      <div className="mb-4 flex-shrink-0 relative">
        <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
          <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
        </div>
        <input
          type="search"
          placeholder="Search messages…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        />
        {(searching) && (
          <div className="absolute inset-y-0 right-3 flex items-center">
            <span className="text-xs text-gray-400">Searching…</span>
          </div>
        )}
      </div>

      {/* Message pane */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-2 text-gray-400">
              <div className="w-6 h-6 border-2 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-sm">Loading messages…</span>
            </div>
          </div>

        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-red-500">{error}</p>
          </div>

        ) : displayed.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="text-5xl mb-3">💬</div>
            <p className="font-medium text-gray-700">
              {isSearch ? 'No messages match your search' : 'No conversations yet'}
            </p>
            <p className="text-sm text-gray-400 mt-1">
              {isSearch
                ? 'Try a different keyword'
                : 'Send a message to Kommand on WhatsApp to get started'}
            </p>
          </div>

        ) : (
          <div className="pb-4 px-1">
            {/* Load more (older messages) at the top */}
            {hasMore && (
              <div className="flex justify-center mb-4">
                <button
                  onClick={() => { void fetchMessages(offset); }}
                  disabled={loadingMore}
                  className="px-4 py-1.5 text-sm text-blue-600 border border-blue-200 rounded-full hover:bg-blue-50 disabled:opacity-50 transition-colors"
                >
                  {loadingMore ? 'Loading…' : `Load more (${total - messages.length} remaining)`}
                </button>
              </div>
            )}

            {displayed.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
          </div>
        )}
      </div>

      {/* Footer: message count */}
      {!loading && !error && messages.length > 0 && (
        <div className="flex-shrink-0 pt-2 border-t border-gray-100 text-center">
          <span className="text-xs text-gray-400">
            {isSearch
              ? `${messages.length} result${messages.length !== 1 ? 's' : ''}`
              : `${messages.length} of ${total} message${total !== 1 ? 's' : ''}`}
          </span>
        </div>
      )}
    </div>
  );
}
