import { supabaseRest, supabaseRpc } from './_supabase.js';

function normalizeStatsRow(row) {
  const total = Number(row && row.total_calls) || 0;
  const tavily = Number(row && row.tavily_calls) || 0;
  const models = row && row.model_counts && typeof row.model_counts === 'object' ? row.model_counts : {};
  return { total, tavily, models };
}

async function readGlobalStats() {
  const rows = await supabaseRest('global_stats?select=total_calls,tavily_calls,model_counts,updated_at&id=eq.1&limit=1');
  return normalizeStatsRow(rows && rows[0] ? rows[0] : null);
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const stats = await readGlobalStats();
      return res.status(200).json({ stats });
    }

    if (req.method === 'POST') {
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const event = String(payload.event || 'model').trim().toLowerCase();

      if (event === 'tavily') {
        await supabaseRpc('increment_tavily_call', {});
        const stats = await readGlobalStats();
        return res.status(200).json({ stats });
      }

      const modelId = String(payload.model_id || '').trim();
      if (!modelId) {
        return res.status(400).json({ error: 'model_id is required for event=model' });
      }

      await supabaseRpc('increment_global_call', { match_model_id: modelId });
      const stats = await readGlobalStats();
      return res.status(200).json({ stats });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Stats error',
      detail: err.data || null,
    });
  }
}
