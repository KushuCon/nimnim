import { requireSession, supabaseRest, supabaseRpc } from './_supabase.js';
import { fetchEmbedding, toVectorLiteral } from './_memory.js';

function preview(text, max = 260) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max) + '...';
}

function cleanQueryVariant(text) {
  return String(text || '')
    .replace(/^[\s\d.\-•]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return Array.from(
    new Set(
      String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2)
    )
  );
}

function lexicalScore(text, queryTerms, rank) {
  const t = String(text || '').toLowerCase();
  let hit = 0;
  for (const q of queryTerms) {
    if (t.includes(q)) hit += 1;
  }
  return hit * 4 + Math.max(0, 2 - rank * 0.02);
}

function dedupeSnippets(items, limit) {
  const out = [];
  const seen = new Set();
  for (const s of items) {
    const key = s.message_id
      ? `m:${s.message_id}`
      : `${s.conversation_id}:${preview(s.text || '', 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function rrf(items, k = 60) {
  const scoreMap = new Map();
  ['vector', 'summary', 'lexical'].forEach((source) => {
    const group = items
      .filter((item) => item.source === source)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    group.forEach((item, rank) => {
      const key = item.message_id ? `m:${item.message_id}` : `${item.conversation_id}:${preview(item.text || '', 80)}`;
      scoreMap.set(key, (scoreMap.get(key) || 0) + 1 / (k + rank + 1));
    });
  });

  return items
    .map((item) => {
      const key = item.message_id ? `m:${item.message_id}` : `${item.conversation_id}:${preview(item.text || '', 80)}`;
      return { ...item, score: scoreMap.get(key) || 0 };
    })
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function getNvidiaApiKey() {
  return process.env.NVIDIA_API_KEY || null;
}

async function expandQueryVariants(query) {
  const apiKey = getNvidiaApiKey();
  if (!apiKey) return [query];

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_QUERY_REWRITE_MODEL || 'microsoft/phi-4-mini-flash-reasoning',
        messages: [
          {
            role: 'system',
            content:
              'Rewrite the user search query into 2 to 3 short semantic search variants. Return one variant per line only. Do not explain.',
          },
          {
            role: 'user',
            content: String(query || ''),
          },
        ],
        max_tokens: 64,
        temperature: 0.2,
        stream: false,
      }),
    });

    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    const variants = String(content || '')
      .split(/\n+/)
      .map(cleanQueryVariant)
      .filter(Boolean);

    const unique = [];
    const seen = new Set();
    [query, ...variants].forEach((value) => {
      const clean = cleanQueryVariant(value);
      if (!clean) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(clean);
    });
    return unique.slice(0, 4);
  } catch {
    return [query];
  }
}

async function fetchFeedbackMap(session, messageIds, conversationIds) {
  if (!messageIds.length) return {};
  const idList = `(${messageIds.join(',')})`;
  const convList = Array.isArray(conversationIds) && conversationIds.length
    ? `(${conversationIds.join(',')})`
    : null;
  try {
    const rows = await supabaseRest(
      `message_feedback?select=message_id,feedback&user_id=eq.${session.user_id}` +
        (convList ? `&conversation_id=in.${convList}` : '') +
        `&message_id=in.${idList}`
    );
    return Object.fromEntries((rows || []).map((row) => [String(row.message_id), row.feedback]));
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const query = String(payload.query || '').trim();
    const conversationId = String(payload.conversation_id || '').trim();
    const scope = payload.scope === 'current' ? 'current' : 'all';
    const limit = Math.max(1, Math.min(Number(payload.limit || 6), 12));

    if (!query) return res.status(200).json({ snippets: [] });

    const conversations = await supabaseRest(
      `conversations?select=id,title,updated_at&user_id=eq.${session.user_id}&order=updated_at.desc&limit=80`
    );
    if (!conversations || !conversations.length) return res.status(200).json({ snippets: [] });

    const titleById = Object.fromEntries(conversations.map((c) => [c.id, c.title || 'Chat']));

    let ids = [];
    if (scope === 'current' && conversationId) {
      ids = conversations.some((c) => c.id === conversationId) ? [conversationId] : [];
    } else {
      ids = conversations.slice(0, 50).map((c) => c.id);
    }

    try {
      const blockedRows = await supabaseRest(
        `rag_blacklist?select=conversation_id&user_id=eq.${session.user_id}`
      );
      const blocked = new Set((blockedRows || []).map((row) => row.conversation_id));
      ids = ids.filter((id) => !blocked.has(id));
    } catch {
      // Blacklist may not be migrated yet.
    }

    if (!ids.length) return res.status(200).json({ snippets: [] });

    const snippets = [];
    const variantQueries = await expandQueryVariants(query);
    const vectorMessageIds = new Set();

    // 1) Vector retrieval from indexed chunks, with query expansion.
    for (const variant of variantQueries) {
      try {
        const emb = await fetchEmbedding(variant);
        if (!emb) continue;
        const vectorRows = await supabaseRpc('match_memory_chunks', {
          query_embedding: toVectorLiteral(emb),
          match_user_id: session.user_id,
          match_conversation_ids: ids,
          match_count: limit * 3,
        });

        (vectorRows || []).forEach((row) => {
          if (row.message_id) vectorMessageIds.add(String(row.message_id));
          snippets.push({
            source: 'vector',
            message_id: row.message_id || null,
            conversation_id: row.conversation_id,
            title: titleById[row.conversation_id] || 'Chat',
            role: row.role,
            text: preview(row.chunk_text),
            created_at: row.created_at,
            score: Math.round((1 - Number(row.similarity || 0)) * 100) / 100,
          });
        });
      } catch {
        // If vector stack is unavailable, fallback layers below still work.
      }
    }

    // 2) Bring periodic summary snapshots.
    try {
      const idList = `(${ids.join(',')})`;
      const sums = await supabaseRest(
        `memory_summaries?select=conversation_id,summary_text,created_at&conversation_id=in.${idList}&order=created_at.desc&limit=8`
      );
      (sums || []).forEach((s, idx) => {
        snippets.push({
          source: 'summary',
          conversation_id: s.conversation_id,
          title: titleById[s.conversation_id] || 'Chat',
          role: 'system',
          message_id: null,
          text: preview(s.summary_text, 320),
          created_at: s.created_at,
          score: Math.max(0.4, 1.2 - idx * 0.08),
        });
      });
    } catch {
      // Summary table may not exist yet before migration.
    }

    // 3) Lexical fallback for robustness.
    if (snippets.length < limit) {
      const idList = `(${ids.join(',')})`;
      const rows = await supabaseRest(
        `messages?select=id,conversation_id,role,content,created_at&conversation_id=in.${idList}&order=created_at.desc&limit=1200`
      );
      const terms = tokenize([query, ...variantQueries].join(' '));
      const scored = (rows || [])
        .filter((r) => r && r.content)
        .map((r, idx) => ({
          source: 'lexical',
          message_id: r.id || null,
          conversation_id: r.conversation_id,
          title: titleById[r.conversation_id] || 'Chat',
          role: r.role,
          text: preview(r.content),
          created_at: r.created_at,
          score: lexicalScore(r.content, terms, idx),
        }))
        .filter((r) => r.score > 1)
        .sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)));

      snippets.push(...scored.slice(0, limit * 3));
    }

    // 4) Pinned messages always surface first.
    try {
      const idList = `(${ids.join(',')})`;
      const pinnedRows = await supabaseRest(
        `pinned_messages?select=message_id,conversation_id,created_at&user_id=eq.${session.user_id}&conversation_id=in.${idList}&order=created_at.desc&limit=40`
      );
      const pinnedMessageIds = Array.from(
        new Set((pinnedRows || []).map((row) => String(row.message_id)).filter(Boolean))
      );
      if (pinnedMessageIds.length) {
        const pinnedMessageRows = await supabaseRest(
          `messages?select=id,conversation_id,role,content,model_id,created_at&id=in.(${pinnedMessageIds.join(',')})&conversation_id=in.${idList}`
        );
        (pinnedMessageRows || []).forEach((row, idx) => {
          snippets.push({
            source: 'pinned',
            pinned: true,
            message_id: row.id,
            conversation_id: row.conversation_id,
            title: titleById[row.conversation_id] || 'Chat',
            role: row.role,
            text: preview(row.content),
            created_at: row.created_at,
            score: 999 - idx * 0.01,
          });
        });
      }
    } catch {
      // Pinned content is best-effort.
    }

    const allMessageIds = Array.from(
      new Set(snippets.map((snippet) => String(snippet.message_id || '')).filter(Boolean))
    );
    const feedbackMap = await fetchFeedbackMap(session, allMessageIds, ids);
    snippets.forEach((snippet) => {
      if (!snippet.message_id) return;
      const feedback = feedbackMap[String(snippet.message_id)];
      if (feedback === 'down') snippet.score = Number(snippet.score || 0) - 2;
      if (feedback === 'up') snippet.score = Number(snippet.score || 0) + 0.5;
    });

    // Conversation-level downvote penalty.
    try {
      const downvotes = await supabaseRest(
        `message_feedback?select=conversation_id&user_id=eq.${session.user_id}&feedback=eq.down`
      );
      const badConvos = new Set((downvotes || []).map((row) => row.conversation_id));
      snippets.forEach((snippet) => {
        if (badConvos.has(snippet.conversation_id)) {
          snippet.score = Number(snippet.score || 0) - 2;
        }
      });
    } catch {
      // Non-fatal, keep retrieval flow running.
    }

    // Pin boost so pinned notes remain top-priority.
    try {
      const pins = await supabaseRest(
        `pinned_messages?select=message_id&user_id=eq.${session.user_id}`
      );
      const pinnedIds = new Set((pins || []).map((pin) => String(pin.message_id)));
      snippets.forEach((snippet) => {
        if (snippet.message_id && pinnedIds.has(String(snippet.message_id))) {
          snippet.score = Number(snippet.score || 0) + 10;
        }
      });
    } catch {
      // Non-fatal, keep retrieval flow running.
    }

    const pinned = snippets.filter((snippet) => snippet.source === 'pinned').sort((a, b) => b.score - a.score);
    const fused = rrf(snippets.filter((snippet) => snippet.source !== 'pinned'));
    return res.status(200).json({ snippets: dedupeSnippets([...pinned, ...fused], limit) });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'RAG retrieval error',
      detail: err.data || null,
    });
  }
}