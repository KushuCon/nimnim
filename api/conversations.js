import { requireSession, supabaseRest } from './_supabase.js';

function normalizeTags(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((part) => part.trim());

  const out = [];
  const seen = new Set();
  for (const tag of raw) {
    const clean = String(tag || '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 24);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function estimateConversationTokens(messages) {
  return (messages || []).reduce((sum, msg) => sum + estimateTokens(msg && msg.content), 0);
}

async function getOwnedConversation(conversationId, userId) {
  const rows = await supabaseRest(
    `conversations?select=id,title,tags,total_tokens_est&user_id=eq.${userId}&id=eq.${conversationId}&limit=1`
  );
  return rows && rows[0] ? rows[0] : null;
}

async function getConversationMessages(conversationId) {
  return await supabaseRest(
    `messages?select=id,role,content,model_id,created_at&conversation_id=eq.${conversationId}&order=id.asc`
  );
}

export default async function handler(req, res) {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    if (req.method === 'GET') {
      const rows = await supabaseRest(
        `conversations?select=id,title,tags,total_tokens_est,created_at,updated_at&user_id=eq.${session.user_id}&order=updated_at.desc`
      );
      return res.status(200).json({ conversations: rows || [] });
    }

    if (req.method === 'POST') {
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const sourceConversationId = String(payload.source_conversation_id || '').trim();
      const forkMessageId = String(payload.fork_message_id || '').trim();
      const title = String(payload.title || 'New Chat').trim().slice(0, 120) || 'New Chat';
      const tags = normalizeTags(payload.tags || []);

      if (sourceConversationId && forkMessageId) {
        const sourceConversation = await getOwnedConversation(sourceConversationId, session.user_id);
        if (!sourceConversation) {
          return res.status(404).json({ error: 'Conversation not found' });
        }

        const sourceMessages = await getConversationMessages(sourceConversationId);
        const forkIndex = (sourceMessages || []).findIndex((row) => String(row.id) === forkMessageId);
        if (forkIndex < 0) {
          return res.status(404).json({ error: 'Message not found' });
        }

        const copiedMessages = (sourceMessages || []).slice(0, forkIndex + 1);
        const forkTitle = String(payload.title || `Fork of ${sourceConversation.title || 'New Chat'}`)
          .trim()
          .slice(0, 120) || `Fork of ${sourceConversation.title || 'New Chat'}`;
        const forkTags = tags.length ? tags : normalizeTags(sourceConversation.tags || []);

        const conversationRows = await supabaseRest('conversations', {
          method: 'POST',
          body: [
            {
              user_id: session.user_id,
              title: forkTitle,
              tags: forkTags,
              total_tokens_est: estimateConversationTokens(copiedMessages),
            },
          ],
        });

        const conversation = conversationRows && conversationRows[0] ? conversationRows[0] : null;
        if (!conversation) {
          return res.status(500).json({ error: 'Could not create forked conversation' });
        }

        if (copiedMessages.length) {
          await supabaseRest('messages', {
            method: 'POST',
            body: copiedMessages.map((msg) => ({
              conversation_id: conversation.id,
              role: msg.role,
              content: msg.content,
              model_id: msg.model_id || null,
            })),
          });
        }

        return res.status(200).json({ conversation });
      }

      const rows = await supabaseRest('conversations', {
        method: 'POST',
        body: [{ user_id: session.user_id, title, tags, total_tokens_est: 0 }],
      });

      return res.status(200).json({ conversation: rows[0] });
    }

    if (req.method === 'PATCH') {
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const id = String(payload.id || '').trim();
      const hasTitle = Object.prototype.hasOwnProperty.call(payload, 'title');
      const hasTags = Object.prototype.hasOwnProperty.call(payload, 'tags');
      const title = hasTitle ? String(payload.title || '').trim().slice(0, 120) : null;
      const tags = hasTags ? normalizeTags(payload.tags || []) : null;

      if (!id) {
        return res.status(400).json({ error: 'Conversation id is required' });
      }
      if (!hasTitle && !hasTags) {
        return res.status(400).json({ error: 'Nothing to update' });
      }
      if (hasTitle && !title && !hasTags) {
        return res.status(400).json({ error: 'Title is required' });
      }

      const owned = await supabaseRest(
        `conversations?select=id&user_id=eq.${session.user_id}&id=eq.${id}&limit=1`
      );
      if (!owned || !owned.length) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const body = { updated_at: new Date().toISOString() };
      if (hasTitle) body.title = title || 'New Chat';
      if (hasTags) body.tags = tags;

      const rows = await supabaseRest(`conversations?id=eq.${id}`, {
        method: 'PATCH',
        body,
      });

      return res.status(200).json({
        conversation: rows && rows[0] ? rows[0] : { id, title: body.title, tags: body.tags },
      });
    }

    if (req.method === 'DELETE') {
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const id = String(payload.id || req.query.id || '').trim();

      if (!id) {
        return res.status(400).json({ error: 'Conversation id is required' });
      }

      const owned = await supabaseRest(
        `conversations?select=id&user_id=eq.${session.user_id}&id=eq.${id}&limit=1`
      );
      if (!owned || !owned.length) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      await supabaseRest(`conversations?id=eq.${id}`, {
        method: 'DELETE',
      });

      return res.status(200).json({ deleted: true, id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Conversation error',
      detail: err.data || null,
    });
  }
}
